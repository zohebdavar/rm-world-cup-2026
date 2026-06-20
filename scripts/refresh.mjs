#!/usr/bin/env node
/**
 * Auto-refresh Real Madrid World Cup 2026 goal data — ACCURATE source.
 *
 * Source: football-data.org  (https://www.football-data.org)
 *   GET /v4/competitions/WC/scorers?limit=100  ->  exact goal totals per player.
 * Requires a free API token in the FOOTBALL_DATA_TOKEN environment variable
 * (set as a GitHub Actions secret). Get one free at football-data.org/client/register.
 *
 * It matches the tournament's scorers against a fixed list of current & former
 * Real Madrid players and writes data.json. On any failure (no token, API error,
 * empty result) it leaves the existing data.json untouched — the site never breaks.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "..", "data.json");

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API = "https://api.football-data.org/v4/competitions/WC/scorers?limit=100";

/* ---- Roster (source of truth). Goals are filled in from the feed. ---- */
const CURRENT = [
  { name: "Kylian Mbappé",       country: "France",  code: "fr",     pos: "FW" },
  { name: "Vinícius Júnior",     country: "Brazil",  code: "br",     pos: "FW" },
  { name: "Jude Bellingham",     country: "England", code: "gb-eng", pos: "MF" },
  { name: "Federico Valverde",   country: "Uruguay", code: "uy",     pos: "MF" },
  { name: "Aurélien Tchouaméni", country: "France",  code: "fr",     pos: "MF" },
  { name: "Antonio Rüdiger",     country: "Germany", code: "de",     pos: "DF" },
  { name: "Arda Güler",          country: "Turkey",  code: "tr",     pos: "MF" },
  { name: "Brahim Díaz",         country: "Morocco", code: "ma",     pos: "FW" },
  { name: "David Alaba",         country: "Austria", code: "at",     pos: "DF" },
  { name: "Thibaut Courtois",    country: "Belgium", code: "be",     pos: "GK" },
];
const FORMER = [
  { name: "Cristiano Ronaldo", country: "Portugal", code: "pt" },
  { name: "Luka Modrić",       country: "Croatia",  code: "hr" },
  { name: "Achraf Hakimi",     country: "Morocco",  code: "ma" },
  { name: "Casemiro",          country: "Brazil",   code: "br" },
  { name: "James Rodríguez",   country: "Colombia", code: "co" },
  { name: "Martin Ødegaard",   country: "Norway",   code: "no" },
];

/* feed team names -> our roster country */
const NATION_ALIASES = {
  "turkey": ["turkey", "turkiye", "türkiye"],
  "england": ["england"],
};
const norm = (s) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const tokens = (s) => norm(s).split(" ").filter(Boolean);
const surname = (s) => { const t = tokens(s); return t[t.length - 1] || ""; };

function teamMatches(rosterCountry, feedTeam) {
  const c = norm(rosterCountry), f = norm(feedTeam);
  const aliases = NATION_ALIASES[c] || [c];
  return aliases.some((a) => f === a || f.includes(a) || a.includes(f));
}

/* Resolve a roster player's goals from the feed's scorer list. */
function goalsForPlayer(p, scorers) {
  const sn = surname(p.name);
  const rosterTokens = tokens(p.name);
  let goals = 0, matched = false;
  for (const s of scorers) {
    const apiTokens = tokens(s.player && s.player.name);
    if (!apiTokens.length) continue;
    const teamOk = teamMatches(p.country, (s.team && s.team.name) || "");
    if (!teamOk) continue;
    const surnameOk = apiTokens.includes(sn);
    const allTokensOk = rosterTokens.every((t) => apiTokens.includes(t));
    if (surnameOk || allTokensOk) { goals += Number(s.goals || 0); matched = true; }
  }
  return { goals, matched };
}

async function getScorers() {
  if (!TOKEN) throw new Error("FOOTBALL_DATA_TOKEN is not set");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  const res = await fetch(API, { signal: ctrl.signal, headers: { "X-Auth-Token": TOKEN } });
  clearTimeout(t);
  if (!res.ok) throw new Error("football-data.org returned HTTP " + res.status);
  const j = await res.json();
  if (!Array.isArray(j.scorers)) throw new Error("unexpected response shape");
  return j.scorers;
}

function build(arr, withPos, scorers) {
  return arr.map((p) => {
    const { goals } = goalsForPlayer(p, scorers);
    const row = { name: p.name, country: p.country, code: p.code, goals };
    if (withPos) row.pos = p.pos;
    row.detail = "";
    return row;
  });
}

async function main() {
  let scorers;
  try {
    scorers = await getScorers();
  } catch (err) {
    console.error("Could not fetch scorers — keeping existing data.json:", err.message);
    process.exit(0);
  }
  console.log(`Fetched ${scorers.length} tournament scorers.`);

  const out = {
    asOf: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    stage: "Auto-updated",
    updated: new Date().toISOString(),
    current: build(CURRENT, true, scorers),
    former: build(FORMER, false, scorers),
  };

  const total = out.current.reduce((s, p) => s + p.goals, 0) + out.former.reduce((s, p) => s + p.goals, 0);

  // Guard: if the feed gave us scorers but none matched our roster, that's suspicious
  // (e.g. a naming/competition mismatch). Keep the last good data rather than zeroing out.
  let prevTotal = -1;
  try {
    const prev = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    prevTotal = [...(prev.current || []), ...(prev.former || [])].reduce((s, p) => s + (Number(p.goals) || 0), 0);
  } catch (_) {}
  if (total === 0 && scorers.length > 0 && prevTotal > 0) {
    console.error("No roster matches in a non-empty scorer list — keeping existing data.json.");
    process.exit(0);
  }

  writeFileSync(DATA_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote data.json — Real Madrid total: ${total} (was ${prevTotal}).`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => { console.error("Refresh failed:", err); process.exit(0); });
}

export { norm, surname, tokens, goalsForPlayer, teamMatches, CURRENT, FORMER };
