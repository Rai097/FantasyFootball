// ADVERSARIAL tests (tester, not developer) for the Waivers v3 import path: Yahoo player-list HTML variants →
// availability ("FA" / "W") → waiverStatusOf, and the bookmarklet end to end under a fake browser (fake
// document / location / fetch / clipboard), so a failing or truncated status=W read can be observed.
// Invariants: nothing throws; an unreadable owner column is never silently all-true or all-false.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { availabilityFrom, parsePlayersHtml, playerKey, waiverStatusOf, type ScrapedPlayer } from "../../web/src/import/yahooHtml.js";
import { validateImport } from "./import.js";

// ------------------------------------------------------------------ HTML builders
interface RowSpec {
  id?: string; // Yahoo player id; omitted for a defense (team link)
  teamSlug?: string; // /nfl/teams/<slug> for a defense
  name: string;
  teamPos: string; // "Det - WR"
  owner?: string | null; // owner cell text; null = no owner cell at all
  injury?: string;
  extra?: string[]; // extra cells
  ownerFirst?: boolean; // owner cell before the name cell
}
function row(r: RowSpec): string {
  const href = r.id ? `https://sports.yahoo.com/nfl/players/${r.id}` : `https://sports.yahoo.com/nfl/teams/${r.teamSlug}/`;
  const name = `<td><div class="ysf-player-name"><a class="Nowrap name" href="${href}">${r.name}</a> <span class="Fz-xxs">${r.teamPos}</span>${
    r.injury ? ` <span class="F-injury">${r.injury}</span>` : ""
  }</div></td>`;
  const owner = r.owner === null || r.owner === undefined ? "" : `<td class="Ta-c">${r.owner}</td>`;
  const extra = (r.extra ?? ["7", "48.2", "12%"]).map((c) => `<td>${c}</td>`).join("");
  return `<tr>${r.ownerFirst ? owner + name : name + owner}${extra}</tr>`;
}
const page = (rows: RowSpec[]) =>
  `<html><head><title>Players | L | Yahoo! Sports</title></head><body><table><thead><tr><th>Offense</th><th>Owner</th></tr></thead><tbody>${rows
    .map(row)
    .join("\n")}</tbody></table></body></html>`;

const byName = (ps: ScrapedPlayer[]) => Object.fromEntries(ps.map((p) => [p.name, p]));

// ------------------------------------------------------------------ owner-cell variants
test("owner cell variants: FA, W (Wed), W (10/28), Waivers, W&nbsp;(Thu), empty, missing", () => {
  const r = parsePlayersHtml(
    page([
      { id: "1", name: "Alpha One", teamPos: "Det - WR", owner: "FA" },
      { id: "2", name: "Bravo Two", teamPos: "Atl - RB", owner: "W (Wed)" },
      { id: "3", name: "Charlie Three", teamPos: "NE - TE", owner: "W (10/28)" },
      { id: "4", name: "Delta Four", teamPos: "NYG - QB", owner: "Waivers" },
      { id: "5", name: "Echo Five", teamPos: "Bal - WR", owner: "W&nbsp;(Thu)" },
      { id: "6", name: "Fox Six", teamPos: "Mia - RB", owner: "" },
      { id: "7", name: "Golf Seven", teamPos: "Sea - WR", owner: null },
      { id: "8", name: "Hotel Eight", teamPos: "Chi - WR", owner: "<span>FA</span>" },
      { id: "9", name: "India Nine", teamPos: "Chi - RB", owner: "<a href='/f1/1/playerswatch'>W (Wed)</a>" },
    ]),
  );
  const by = byName(r.players);
  assert.equal(by["Alpha One"].availability, "FA");
  assert.equal(by["Bravo Two"].availability, "W");
  assert.equal(by["Bravo Two"].waiverUntil, "Wed");
  assert.equal(by["Charlie Three"].availability, "W");
  assert.equal(by["Charlie Three"].waiverUntil, "10/28");
  assert.equal(by["Delta Four"].availability, "W");
  assert.equal(by["Echo Five"].availability, "W");
  assert.equal(by["Echo Five"].waiverUntil, "Thu");
  assert.equal(by["Fox Six"].availability, undefined, "empty owner cell must stay unknown");
  assert.equal(by["Golf Seven"].availability, undefined, "missing owner cell must stay unknown");
  assert.equal(by["Hotel Eight"].availability, "FA");
  assert.equal(by["India Nine"].availability, "W");
  assert.equal(r.diag.availability, "FA:2,W:5,none:2");
});

test("reordered columns (owner cell first) and extra columns still read the owner cell", () => {
  const r = parsePlayersHtml(
    page([
      { id: "11", name: "Owner First", teamPos: "KC - WR", owner: "FA", ownerFirst: true },
      { id: "12", name: "Many Cols", teamPos: "KC - RB", owner: "W (Sun)", extra: ["@Den", "Sun 1:00 pm", "7", "48.2", "12%", "3", "+2"] },
    ]),
  );
  const by = byName(r.players);
  assert.equal(by["Owner First"].availability, "FA");
  assert.equal(by["Many Cols"].availability, "W");
  assert.equal(by["Many Cols"].waiverUntil, "Sun");
});

test("no owner column on any row: every player unknown and a diagnostics note (never all FA / all W)", () => {
  const rows: RowSpec[] = Array.from({ length: 10 }, (_, i) => ({ id: String(100 + i), name: `Player ${String.fromCharCode(65 + i)}x`, teamPos: "Det - WR", owner: null }));
  const r = parsePlayersHtml(page(rows));
  assert.equal(r.players.length, 10);
  assert.ok(r.players.every((p) => p.availability === undefined));
  assert.equal(r.diag.availabilityNote, "owner column (FA / W) not found");
  const ws = waiverStatusOf(r.players, undefined);
  assert.ok([...ws.onWaivers.values()].every((v) => v === undefined));
  assert.equal(ws.diag.unknown, 10);
});

test("a last-game result cell 'W' (win) must not mark a free agent as on waivers", () => {
  // Yahoo's player list can show the last game's result; a bare "W" cell is a win, not a waiver flag,
  // when the row's owner cell already says FA.
  const r = parsePlayersHtml(page([{ id: "21", name: "Winner Guy", teamPos: "Det - WR", owner: "FA", extra: ["W", "27-20", "7"] }]));
  assert.equal(r.players[0].availability, "FA");
  // And when the result cell comes BEFORE the owner cell:
  const html = `<table><tr><td><a href="https://sports.yahoo.com/nfl/players/22">Result First</a> <span>Det - WR</span></td><td>W</td><td>FA</td></tr></table>`;
  const r2 = parsePlayersHtml(html);
  assert.equal(r2.players[0].availability, "FA", `result cell "W" read as the owner cell: ${JSON.stringify(r2.players[0])}`);
});

test("injury tags (Q, O, IR) do not disturb availability", () => {
  const r = parsePlayersHtml(
    page([
      { id: "31", name: "Questionable Guy", teamPos: "Det - WR", owner: "W (Wed)", injury: "Q" },
      { id: "32", name: "Out Guy", teamPos: "Det - RB", owner: "FA", injury: "O" },
      { id: "33", name: "IR Guy", teamPos: "Det - TE", owner: "FA", injury: "IR" },
    ]),
  );
  const by = byName(r.players);
  assert.equal(by["Questionable Guy"].status, "Q");
  assert.equal(by["Questionable Guy"].availability, "W");
  assert.equal(by["Out Guy"].status, "O");
  assert.equal(by["Out Guy"].availability, "FA");
  assert.equal(by["IR Guy"].status, "IR");
  assert.equal(by["IR Guy"].availability, "FA");
});

test("K and DEF rows: kicker by id, defense by team link (city name and full team name)", () => {
  const r = parsePlayersHtml(
    page([
      { id: "41", name: "Long Kicker", teamPos: "Bal - K", owner: "W (Thu)" },
      { teamSlug: "cle", name: "Cleveland Browns", teamPos: "Cle - DEF", owner: "FA" },
      { teamSlug: "kc", name: "Kansas City", teamPos: "KC - DEF", owner: "W (Wed)" },
    ]),
  );
  const by = byName(r.players);
  assert.equal(by["Long Kicker"].pos, "K");
  assert.equal(by["Long Kicker"].availability, "W");
  assert.deepEqual(by["Cleveland Browns"], { name: "Cleveland Browns", pos: "DEF", team: "CLE", availability: "FA" });
  assert.equal(by["Kansas City"].team, "KC");
  assert.equal(by["Kansas City"].availability, "W");
  assert.equal(playerKey(by["Cleveland Browns"]), "Cleveland Browns|DEF", "defenses keyed by name|pos (no Yahoo id)");
});

test("DEF team link with a long slug (/nfl/teams/kansas-city/) keeps the row's team abbreviation", () => {
  const html = page([{ teamSlug: "kansas-city", name: "Kansas City", teamPos: "KC - DEF", owner: "FA" }]);
  const r = parsePlayersHtml(html);
  // Either the defense is found with team KC, or it is skipped — never a wrong team such as "KANS".
  const d = r.players.find((p) => p.pos === "DEF");
  if (d) assert.equal(d.team, "KC", JSON.stringify(d));
});

test("non-ASCII and suffix names: Ja'Marr, St. Brown, Jr., III, accents, &#39; entities", () => {
  const r = parsePlayersHtml(
    page([
      { id: "51", name: "Ja&#39;Marr Chase", teamPos: "Cin - WR", owner: "FA" },
      { id: "52", name: "Amon-Ra St. Brown", teamPos: "Det - WR", owner: "W (Wed)" },
      { id: "53", name: "Marvin Harrison Jr.", teamPos: "Ari - WR", owner: "FA" },
      { id: "54", name: "Michael Pittman Jr.", teamPos: "Ind - WR", owner: "W (10/29)" },
      { id: "55", name: "Robert Griffin III", teamPos: "Was - QB", owner: "FA" },
      { id: "56", name: "Ka&#8217;imi Fairbairn", teamPos: "Hou - K", owner: "FA" },
      { id: "57", name: "José Ramírez", teamPos: "Mia - RB", owner: "FA" },
    ]),
  );
  const by = byName(r.players);
  assert.ok(by["Ja'Marr Chase"], `names: ${r.players.map((p) => p.name).join(" | ")}`);
  assert.equal(by["Amon-Ra St. Brown"].availability, "W");
  assert.equal(by["Marvin Harrison Jr."].availability, "FA");
  assert.equal(by["Michael Pittman Jr."].waiverUntil, "10/29");
  assert.equal(by["Robert Griffin III"].pos, "QB");
  assert.equal(by["Ka’imi Fairbairn"].pos, "K");
  assert.equal(by["José Ramírez"].team, "MIA");
  assert.equal(r.players.length, 7);
});

test("availabilityFrom: odd cells never throw and never match partial words", () => {
  for (const s of ["", "\t\t", "FAQ", "FA FA", "W/R/T", "WR", "Waiver Wire", "W ()", "W (" + "x".repeat(40) + ")", "fa", "w (wed)", "\u0000", "W (Wed)"]) {
    assert.doesNotThrow(() => availabilityFrom(s), s);
  }
  assert.equal(availabilityFrom("FAQ"), undefined);
  assert.equal(availabilityFrom("Waiver Wire"), undefined);
  assert.equal(availabilityFrom("W/R/T"), undefined);
  assert.equal(availabilityFrom("W (" + "x".repeat(40) + ")"), undefined, "a long parenthesis is not a waiver date");
});

test("parsePlayersHtml survives garbage, huge and truncated pages", () => {
  for (const html of ["", "<", "<tr><td><a href='/nfl/players/1'>", "<a href='/nfl/players/1'>X</a>".repeat(3000), "<table>" + "<tr><td>FA</td></tr>".repeat(5000)]) {
    assert.doesNotThrow(() => parsePlayersHtml(html));
  }
});

// ------------------------------------------------------------------ waiverStatusOf edge cases
test("waiverStatusOf: duplicated players across FA and W pages keep the column reading", () => {
  const ps: ScrapedPlayer[] = [
    { yahooId: "1", name: "A", pos: "WR", availability: "FA" },
    { yahooId: "2", name: "B", pos: "WR", availability: "W" },
  ];
  const r = waiverStatusOf(ps, { keys: new Set(["1", "2"]), complete: true, ignored: false });
  assert.equal(r.onWaivers.get("1"), false);
  assert.equal(r.onWaivers.get("2"), true);
  assert.equal(r.diag.disagree, 1);
});

test("waiverStatusOf: empty status=W page and no owner column → unknown + not used (never all free agents)", () => {
  const ps: ScrapedPlayer[] = Array.from({ length: 30 }, (_, i) => ({ yahooId: String(i), name: `P${i}`, pos: "WR" }));
  const r = waiverStatusOf(ps, { keys: new Set(), complete: true, ignored: false });
  assert.ok([...r.onWaivers.values()].every((v) => v === undefined));
  assert.equal(r.diag.listUsed, false);
  assert.equal(r.diag.unknown, 30);
});

test("waiverStatusOf: an offense W list that is empty while the K list is not → offense must not all become free agents", () => {
  // Owner column unreadable everywhere. status=W&pos=O parsed 0 players (unreadable or blocked), but the K page
  // found one kicker. That single kicker key must not make every offensive player a 'free agent'.
  const offense: ScrapedPlayer[] = Array.from({ length: 40 }, (_, i) => ({ yahooId: String(i), name: `P${i}`, pos: i % 2 ? "WR" : "RB" }));
  const k: ScrapedPlayer = { yahooId: "900", name: "Kicker", pos: "K" };
  const r = waiverStatusOf([...offense, k], { keys: new Set(["900"]), complete: true, ignored: false });
  const offVals = offense.map((p) => r.onWaivers.get(playerKey(p)));
  assert.ok(!offVals.every((v) => v === false), "every offensive player marked a free agent from an empty offense W list");
});

// ------------------------------------------------------------------ the bookmarklet under a fake browser
const BOOKMARKLET = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/src/import/bookmarklet.ts")).href;

interface FakeEl {
  tag: string;
  textContent: string;
  children: FakeEl[];
  onclick?: () => unknown;
  id?: string;
  setAttribute: (k: string, v: string) => void;
  appendChild: (c: FakeEl) => FakeEl;
  append: (...c: FakeEl[]) => void;
  remove: () => void;
  select: () => void;
  click: () => void;
}
function fakeEl(tag: string): FakeEl {
  const e: FakeEl = {
    tag,
    textContent: "",
    children: [],
    setAttribute: () => undefined,
    appendChild: (c) => (e.children.push(c), c),
    append: (...c) => void e.children.push(...c),
    remove: () => undefined,
    select: () => undefined,
    click: () => undefined,
  };
  return e;
}
const walk = (e: FakeEl, out: FakeEl[] = []): FakeEl[] => (out.push(e), e.children.forEach((c) => walk(c, out)), out);

type Route = (url: URL) => { status: number; html: string } | "throw";
let runN = 0;
/** Runs the real bookmarklet against `route`; returns the payload it would copy. */
async function runBookmarklet(route: Route): Promise<{ payload: any; diagnostics: any[] }> {
  const body = fakeEl("body");
  const g = globalThis as any;
  const saved = { location: g.location, document: g.document, fetch: g.fetch };
  let copied = "";
  g.location = { pathname: "/f1/1405188/players", hostname: "football.fantasysports.yahoo.com", origin: "https://football.fantasysports.yahoo.com" };
  g.document = {
    documentElement: { outerHTML: "<html></html>" },
    body,
    createElement: (t: string) => fakeEl(t),
    getElementById: () => null,
  };
  g.fetch = async (u: string) => {
    const url = new URL(u);
    const r = route(url);
    if (r === "throw") throw new TypeError("Failed to fetch");
    return { ok: r.status >= 200 && r.status < 300, status: r.status, url: u, redirected: false, text: async () => r.html };
  };
  Object.defineProperty(g.navigator, "clipboard", { value: { writeText: async (s: string) => void (copied = s) }, configurable: true });
  try {
    await import(`${BOOKMARKLET}?run=${++runN}`);
    const deadline = Date.now() + 10_000;
    let copy: FakeEl | undefined;
    while (!(copy = walk(body).find((e) => e.textContent === "Copy to clipboard"))) {
      const fail = walk(body).find((e) => /import failed/.test(e.textContent));
      if (fail) throw new Error(fail.textContent);
      if (Date.now() > deadline) throw new Error("bookmarklet did not finish");
      await new Promise((r) => setTimeout(r, 10));
    }
    await copy.onclick!();
    const payload = JSON.parse(copied);
    return { payload, diagnostics: payload.diagnostics };
  } finally {
    g.location = saved.location;
    g.document = saved.document;
    g.fetch = saved.fetch;
  }
}

/** A league with 2 teams; `lists` maps "A|O" / "W|K" … to the rows of page `count/25`. */
function leagueRoute(lists: Record<string, RowSpec[][] | "throw" | number>): Route {
  return (url) => {
    const p = url.pathname;
    if (/\/f1\/1405188\/(1|2)$/.test(p)) {
      const n = p.slice(-1);
      return { status: 200, html: `<title>L - Team ${n} | Yahoo</title>` + page([{ id: `90${n}`, name: `Rostered Guy${n}`, teamPos: "KC - QB", owner: null }]) };
    }
    if (/\/f1\/1405188\/\d+$/.test(p)) return { status: 404, html: "" };
    if (p.endsWith("/settings")) return { status: 404, html: "" };
    if (p.endsWith("/players")) {
      const key = `${url.searchParams.get("status")}|${url.searchParams.get("pos")}`;
      const pages = lists[key];
      if (pages === "throw") return "throw";
      if (typeof pages === "number") return { status: pages, html: "" };
      const i = Math.floor(Number(url.searchParams.get("count") ?? 0) / 25);
      return { status: 200, html: page(pages?.[i] ?? []) };
    }
    return { status: 404, html: "" };
  };
}
const offenseRows = (from: number, n: number, owner: string | null = null): RowSpec[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(from + i), name: `Off Player${from + i}`, teamPos: i % 2 ? "Det - WR" : "Atl - RB", owner }));
const kRows = (n: number, owner: string | null = null): RowSpec[] => Array.from({ length: n }, (_, i) => ({ id: String(5000 + i), name: `Kick Er${i}`, teamPos: "Bal - K", owner }));
const defRows = (owner: string | null = null): RowSpec[] => [
  { teamSlug: "cle", name: "Cleveland", teamPos: "Cle - DEF", owner },
  { teamSlug: "buf", name: "Buffalo", teamPos: "Buf - DEF", owner },
];
const faOf = (payload: any, name: string) => payload.freeAgents.find((f: any) => f.name === name);

test("bookmarklet: owner column readable → onWaivers per player, K and DEF included", async () => {
  const { payload, diagnostics } = await runBookmarklet(
    leagueRoute({
      "A|O": [[...offenseRows(100, 3, "FA"), ...offenseRows(200, 2, "W (Wed)")]],
      "A|K": [kRows(2, "W (Thu)")],
      "A|DEF": [defRows("FA")],
      "W|O": [offenseRows(200, 2, "W (Wed)")],
      "W|K": [kRows(2, "W (Thu)")],
      "W|DEF": [[]],
    }),
  );
  assert.equal(payload.freeAgents.length, 9);
  assert.equal(faOf(payload, "Off Player100").onWaivers, false);
  assert.equal(faOf(payload, "Off Player200").onWaivers, true);
  assert.equal(faOf(payload, "Kick Er0").onWaivers, true);
  assert.equal(faOf(payload, "Cleveland").onWaivers, false);
  assert.equal(faOf(payload, "Cleveland").pos, "DEF");
  assert.equal(faOf(payload, "Cleveland").yahooId, undefined);
  assert.ok(diagnostics.some((d) => d.step === "waiverStatus"));
});

test("bookmarklet: status=W fetch error (offense) and no owner column → every free agent unknown, with diagnostics", async () => {
  const { payload, diagnostics } = await runBookmarklet(
    leagueRoute({ "A|O": [offenseRows(100, 5)], "A|K": [kRows(2)], "A|DEF": [defRows()], "W|O": "throw", "W|K": "throw", "W|DEF": "throw" }),
  );
  assert.ok(payload.freeAgents.length >= 9);
  for (const f of payload.freeAgents) assert.equal(f.onWaivers, undefined, `${f.name}: ${f.onWaivers}`);
  assert.ok(diagnostics.some((d) => /fetch failed/.test(d.note ?? "")));
  assert.ok(diagnostics.some((d) => d.step === "waiverStatus" && d.unknown >= 9));
});

test("bookmarklet: status=W for K fails (HTTP 500) while offense W works, no owner column → kickers unknown, not free agents", async () => {
  const { payload } = await runBookmarklet(
    leagueRoute({
      "A|O": [offenseRows(100, 6)],
      "A|K": [kRows(3)],
      "A|DEF": [defRows()],
      "W|O": [offenseRows(103, 3)],
      "W|K": 500,
      "W|DEF": [[]],
    }),
  );
  assert.equal(faOf(payload, "Off Player103").onWaivers, true);
  for (let i = 0; i < 3; i++) {
    const k = faOf(payload, `Kick Er${i}`);
    assert.notEqual(k.onWaivers, false, `Kick Er${i}: a failed status=W&pos=K read marked him a free agent`);
  }
});

test("bookmarklet: status=W page 2 fetch fails (list truncated), no owner column → non-members unknown, not free agents", async () => {
  // 30 available offensive players; 25 are on waivers per page 1 of status=W; page 2 (count=25) fails.
  const avail = offenseRows(100, 30);
  const base = leagueRoute({ "A|O": [avail.slice(0, 25), avail.slice(25)], "A|K": [[]], "A|DEF": [[]], "W|O": [offenseRows(100, 25).reverse(), offenseRows(125, 5)], "W|K": [[]], "W|DEF": [[]] });
  // (page 1 of status=W is a different order than status=A, so the "Yahoo ignored the filter" check does not fire)
  const failing: Route = (url) => (url.searchParams.get("status") === "W" && url.searchParams.get("pos") === "O" && url.searchParams.get("count") === "25" ? "throw" : base(url));
  const r = await runBookmarklet(failing);
  const tail = [125, 126, 127, 128, 129].map((n) => faOf(r.payload, `Off Player${n}`));
  for (const f of tail) assert.notEqual(f.onWaivers, false, `${f.name}: truncated W list (fetch failed on page 2) marked him a free agent`);
});

test("bookmarklet: an empty status=W page with a readable owner column trusts the column", async () => {
  const { payload } = await runBookmarklet(
    leagueRoute({ "A|O": [[...offenseRows(100, 2, "FA"), ...offenseRows(300, 1, "W (Wed)")]], "A|K": [[]], "A|DEF": [[]], "W|O": [[]], "W|K": [[]], "W|DEF": [[]] }),
  );
  assert.equal(faOf(payload, "Off Player100").onWaivers, false);
  assert.equal(faOf(payload, "Off Player300").onWaivers, true);
});

test("bookmarklet (developer): Yahoo ignores status=W (same players, another order), no owner column → offense unknown, list marked ignored", async () => {
  const avail = offenseRows(100, 8);
  const { payload, diagnostics } = await runBookmarklet(
    leagueRoute({ "A|O": [avail], "A|K": [[]], "A|DEF": [[]], "W|O": [[...avail].reverse()], "W|K": [[]], "W|DEF": [[]] }),
  );
  for (const f of payload.freeAgents) assert.equal(f.onWaivers, undefined, `${f.name}: ${f.onWaivers}`);
  assert.equal(diagnostics.find((d) => d.step === "waiverStatus").lists.O.ignored, true);
});

// ------------------------------------------------------------------ (developer) import v4: rest-of-season projections
// Team page → "Projected Stats" link → "Remaining Games" link → Fan Pts tables, all discovered by anchor text. The
// query params below are invented; the bookmarklet must follow whatever hrefs the page carries.
const projNav = (n: string) =>
  `<ul><li class="Navitem Selected"><a href="/f1/1405188/${n}?v1=S&amp;v2=W">Stats</a></li><li class="Navitem"><a href="/f1/1405188/${n}?v1=P&amp;v2=W">Projected Stats</a></li></ul>`;
const periodNav = (n: string, selected: boolean) =>
  `<ul><li class="Navitem Default-selected"><a href="/f1/1405188/${n}?v1=P&amp;v2=W">Week 7</a></li><li class="Navitem${selected ? "  Selected" : ""}"><a href="/f1/1405188/${n}?v1=P&amp;v2=RG">Remaining Games</a></li><li class="Navitem"><a href="/f1/1405188/${n}?v1=P&amp;v2=ST">Season Total</a></li></ul>`;
const rosTable = (rows: [RowSpec, string][], nameCol = "Offense") =>
  `<table class="legend"><tr><th>Level</th><th>Rating</th><th>Percentiles</th></tr><tr><td>Elite</td><td>99</td><td>90</td></tr></table>` +
  `<table><thead><tr><th></th><th colspan="2">Fantasy</th></tr><tr><th>${nameCol}</th><th>Fan Pts</th><th>% Ros</th></tr></thead><tbody>${rows
    .map(([r, pts]) => row({ ...r, owner: null, extra: [pts, "90%"] }))
    .join("")}</tbody></table>`;

interface ProjOpts {
  projLink?: boolean;
  remainingLink?: boolean;
  selected?: boolean;
  fanPts?: boolean;
  pts?: Record<string, string>;
  log?: string[];
}
/** Two teams (one player each; team 2 also a DEF); `pts` maps a player id / "buf" to his Fan Pts cell. */
function projRoute(o: ProjOpts = {}): Route {
  const { projLink = true, remainingLink = true, selected = true, fanPts = true, pts = { "901": "235.91", "902": "158.20", buf: "81.5" } } = o;
  const rosterOf = (n: string): RowSpec[] => [{ id: `90${n}`, name: `Rostered Guy${n}`, teamPos: "KC - QB", owner: null }, ...(n === "2" ? [{ teamSlug: "buf", name: "Buffalo", teamPos: "Buf - DEF", owner: null }] : [])];
  return (url) => {
    const m = /\/f1\/1405188\/(\d+)$/.exec(url.pathname);
    if (!m || Number(m[1]) > 2) return { status: 404, html: "" };
    const n = m[1];
    const view = url.searchParams.get("v2");
    if (url.search) o.log?.push(`${n}${url.search}`);
    if (!url.search) return { status: 200, html: `<title>L - Team ${n} | Yahoo</title>${projLink ? projNav(n) : ""}` + page(rosterOf(n)) };
    if (view === "W") return { status: 200, html: remainingLink ? periodNav(n, false) : "<ul><li>Week 7</li></ul>" };
    if (view === "RG") {
      const rows = rosterOf(n).map((r): [RowSpec, string] => [r, pts[r.id ?? r.teamSlug!] ?? "-"]);
      const html = periodNav(n, selected) + (fanPts ? rosTable(rows) : rosTable(rows).replace("Fan Pts", "Yds"));
      return { status: 200, html };
    }
    return { status: 404, html: "" };
  };
}
const playerOf = (payload: any, name: string) => payload.teams.flatMap((t: any) => t.players).find((p: any) => p.name === name);
const rosDiags = (diagnostics: any[]) => diagnostics.filter((d) => d.step === "projections" && d.kind === "ros");

test("bookmarklet v4: Projected Stats → Remaining Games discovered per team; Fan Pts feeds yahooProj (players and DEF); 2 fetches per team", async () => {
  const log: string[] = [];
  const { payload, diagnostics } = await runBookmarklet(projRoute({ log }));
  assert.equal(playerOf(payload, "Rostered Guy1").yahooProj, 235.91);
  assert.equal(playerOf(payload, "Rostered Guy2").yahooProj, 158.2);
  assert.equal(playerOf(payload, "Buffalo").yahooProj, 81.5);
  assert.deepEqual(log, ["1?v1=P&v2=W", "1?v1=P&v2=RG", "2?v1=P&v2=W", "2?v1=P&v2=RG"], "entities decoded; exactly 2 extra fetches per team");
  const sum = diagnostics.find((d) => d.step === "projections" && d.ros !== undefined);
  assert.equal(sum.ros, 3);
  assert.equal(sum.rostered, 3);
  assert.match(sum.note, /Projected Stats → Remaining Games/);
  assert.ok(rosDiags(diagnostics).every((d) => d.viewIndicator === "Remaining Games" && d.column === "Fan Pts"));
  // The payload passes the server's validation with yahooProj kept (0–450).
  const stored = validateImport(payload);
  const kept = stored.teams.flatMap((t) => t.players).map((p) => [p.name, p.yahooProj]);
  assert.deepEqual(kept, [["Rostered Guy1", 235.91], ["Rostered Guy2", 158.2], ["Buffalo", 81.5]]);
});

test("bookmarklet v4: an out-of-range (> 450) or non-numeric Fan Pts leaves yahooProj absent, never 0", async () => {
  const { payload } = await runBookmarklet(projRoute({ pts: { "901": "999.5", "902": "-", buf: "450" } }));
  assert.equal(playerOf(payload, "Rostered Guy1").yahooProj, undefined);
  assert.equal(playerOf(payload, "Rostered Guy2").yahooProj, undefined);
  assert.equal(playerOf(payload, "Buffalo").yahooProj, 450);
});

for (const [name, opts, note] of [
  ["no Projected Stats link", { projLink: false }, /no "Projected Stats" link/],
  ["no Remaining Games link", { remainingLink: false }, /no "Remaining Games" link/],
  ["Remaining Games view not selected", { selected: false }, /Remaining Games view not shown as selected/],
  ["no Fan Pts column", { fanPts: false }, /no Fan Pts column/],
] as const) {
  test(`bookmarklet v4: ${name} → a diagnostics note naming the step; yahooProj absent; import still completes`, async () => {
    const { payload, diagnostics } = await runBookmarklet(projRoute(opts));
    assert.equal(payload.teams.length, 2);
    for (const t of payload.teams) for (const p of t.players) assert.equal(p.yahooProj, undefined, `${p.name}: ${p.yahooProj}`);
    const ros = rosDiags(diagnostics);
    assert.equal(ros.length, 2, "one note per team");
    for (const d of ros) assert.match(d.note ?? "", note);
    assert.match(diagnostics.find((d) => d.step === "projections" && d.ros !== undefined).note, /yahooProj not captured/);
  });
}

test("bookmarklet v4: the Remaining Games fetch failing is recorded and the import still completes", async () => {
  const base = projRoute();
  const { payload, diagnostics } = await runBookmarklet((url) => (url.searchParams.get("v2") === "RG" ? "throw" : base(url)));
  assert.equal(playerOf(payload, "Rostered Guy1").yahooProj, undefined);
  assert.ok(rosDiags(diagnostics).some((d) => /fetch failed/.test(d.note ?? "") && /v2=RG/.test(d.url)));
});
