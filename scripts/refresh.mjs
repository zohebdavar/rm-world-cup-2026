#!/usr/bin/env node
/**
 * Auto-refresh Real Madrid World Cup 2026 goal data.
 * Runs in GitHub Actions on a schedule. No API key required.
 *
 * Source: TheSportsDB free API (FIFA World Cup, league 4429, season 2026).
 *  - eventsday.php  -> list matches per day (scores + status)
 *  - lookuptimeline.php -> per-match goal events with scorer names
 *
 * It tallies goals for a fixed list of current & former Real Madrid players,
 * then writes data.json. On any failure it leaves the existing data.json
 * untouched (graceful degradation — the site never breaks or zeroes out).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "..", "data.json");

const API = "https://www.thesportsdb.com/api/v1/json/3/";
const LEAGUE = "4429";              // FIFA World Cup
const SEASON = "2026";
const START = "2026-06-11";         // tournament kickoff
const END   = "2026-07-19";         // final

/* ---- Roster (source of truth). Goals are filled in from the live feed. ---- */
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

/* Nation aliases so feed team names match our roster countries. */
const NATION_ALIASES = {
  "turkey": ["turkey", "türkiye", "turkiye"],
  "south korea": ["south korea", "korea republic", "korea"],
};
const norm = (s) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const surname = (s) => norm(s).split(" ").pop();

/* Resolve a roster player's goals from the tallied feed data.
   Exact normalized full-name match first, then surname fallback. */
function goalsForPlayer(p, goalsByPlayer, detailByPlayer = {}) {
  const k = norm(p.name);
  if (goalsByPlayer[k] != null) return { g: goalsByPlayer[k], d: detailByPlayer[k] || [] };
  const sn = surname(p.name);
  let g = 0, d = [];
  for (const key of Object.keys(goalsByPlayer)) {
    if (key.split(" ").pop() === sn) { g += goalsByPlayer[key]; d = d.concat(detailByPlayer[key] || []); }
  }
  return { g, d };
}

const ROSTER = [...CURRENT, ...FORMER];
const ROSTER_NATIONS = new Set();
ROSTER.forEach((p) => {
  const base = norm(p.country);
  (NATION_ALIASES[base] || [base]).forEach((a) => ROSTER_NATIONS.add(norm(a)));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 25000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "rm-wc-tracker" } });
      clearTimeout(t);
      if (res.ok) return await res.json();
    } catch (_) { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  return null;
}

function datesInRange(start, end) {
  const out = [];
  const today = new Date();
  let d = new Date(start + "T00:00:00Z");
  const last = new Date(Math.min(new Date(end + "T00:00:00Z").getTime(), today.getTime()));
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

function involvesRoster(e) {
  return ROSTER_NATIONS.has(norm(e.strHomeTeam)) || ROSTER_NATIONS.has(norm(e.strAwayTeam));
}
function isFinished(e) {
  return e.strStatus === "FT" || e.strStatus === "Match Finished" ||
    (e.intHomeScore != null && e.intHomeScore !== "" && e.intAwayScore != null && e.intAwayScore !== "");
}

async function main() {
  // 1) collect all WC matches day by day
  const events = [];
  const seen = new Set();
  for (const day of datesInRange(START, END)) {
    const j = await getJSON(`${API}eventsday.php?d=${day}&l=${LEAGUE}`);
    if (j && Array.isArray(j.events)) {
      for (const e of j.events) {
        if (e && e.idEvent && !seen.has(e.idEvent)) { seen.add(e.idEvent); events.push(e); }
      }
    }
    await sleep(250);
  }
  if (events.length === 0) {
    console.error("No events returned from feed — keeping existing data.json.");
    process.exit(0);
  }

  // 2) finished matches involving a Real Madrid nation
  const matches = events.filter((e) => isFinished(e) && involvesRoster(e));
  console.log(`Found ${events.length} WC events, ${matches.length} relevant finished matches.`);

  // 3) tally goals from each match timeline
  const goalsByPlayer = {};   // normName -> count
  const detailByPlayer = {};  // normName -> [ "vs X 66'" ]
  for (const e of matches) {
    const opp = (t) => (norm(e.strHomeTeam) === norm(t) ? e.strAwayTeam : e.strHomeTeam);
    const tl = await getJSON(`${API}lookuptimeline.php?id=${e.idEvent}`);
    await sleep(250);
    if (!tl || !Array.isArray(tl.timeline)) continue;
    for (const ev of tl.timeline) {
      if (ev.strTimeline === "Goal" && ev.strTimelineDetail !== "Own Goal" && ev.strPlayer) {
        const k = norm(ev.strPlayer);
        goalsByPlayer[k] = (goalsByPlayer[k] || 0) + 1;
        (detailByPlayer[k] = detailByPlayer[k] || []).push(`vs ${opp(ev.strTeam)} ${ev.intTime || "?"}'`);
      }
    }
  }

  // 4) assign goals to roster (exact normalized name, else surname match)
  const build = (arr, withPos) => arr.map((p) => {
    const { g, d } = goalsForPlayer(p, goalsByPlayer, detailByPlayer);
    const row = { name: p.name, country: p.country, code: p.code, goals: g };
    if (withPos) row.pos = p.pos;
    row.detail = g > 0 ? d.join(", ") : "";
    return row;
  });

  const out = {
    asOf: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    stage: "Auto-updated",
    updated: new Date().toISOString(),
    current: build(CURRENT, true),
    former: build(FORMER, false),
  };

  // 5) sanity guard: don't publish an all-zero wipe if we clearly failed to read timelines
  const total = out.current.reduce((s, p) => s + p.goals, 0) + out.former.reduce((s, p) => s + p.goals, 0);
  let prevTotal = -1;
  try {
    const prev = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    prevTotal = [...(prev.current || []), ...(prev.former || [])].reduce((s, p) => s + (+p.goals || 0), 0);
  } catch (_) {}
  if (total === 0 && prevTotal > 0 && matches.length > 0) {
    console.error("Tally came back empty but matches existed — keeping existing data.json.");
    process.exit(0);
  }

  writeFileSync(DATA_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote data.json — total goals: ${total} (was ${prevTotal}).`);
}

/* Run only when invoked directly (so the helpers can be unit-tested on import). */
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => { console.error("Refresh failed:", err); process.exit(0); });
}

export { norm, surname, goalsForPlayer, CURRENT, FORMER };
