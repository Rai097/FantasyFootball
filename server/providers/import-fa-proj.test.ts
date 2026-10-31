// Import v6 (2026-10-28): Yahoo projections for AVAILABLE players, read from the players page's "Stats" control
// ("Week 8 (proj)", and a rest-of-season projected view when present). Synthetic markup only: the option values and
// query params below are INVENTED (S_PW_8 …); the tests prove the bookmarklet follows whatever the markup encodes and
// never guesses a param. The real Yahoo markup is unverified until the owner re-imports (see "faProjections" diagnostics).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIST_VIEW, findStatsView, parseListProjectionHtml, selectedStatsView } from "../../web/src/import/yahooHtml.js";
import { validateImport } from "./import.js";
import { row, runBookmarklet, type Route, type RowSpec } from "./bookmarkletHarness.js";

const PAGE = "https://football.fantasysports.yahoo.com/f1/1405188/players?status=A&pos=DEF&sort=AR&count=0";

const statsForm = (selected: string, opts: { method?: string; action?: string; extra?: string } = {}) =>
  `<form id="playerfilter" method="${opts.method ?? "get"}" action="${opts.action ?? "/f1/1405188/players"}">` +
  `<input type="hidden" name="cut_type" value="9"><input type="checkbox" name="myteam" value="1"><input type="submit" value="Go">` +
  `<select name="stat1" id="statselect">${[
    ["S_S_2026", "Season (2026)"],
    ["S_W_7", "Week 7"],
    ["S_PW_9", "Week 9 (proj)"],
    ["S_PW_8", "Week 8 (proj)"],
    ["S_PSR", "Remaining Season (proj)"],
  ]
    .map(([v, t]) => `<option value="${v}"${t === selected ? " selected" : ""}>${t}</option>`)
    .join("")}</select>${opts.extra ?? ""}</form>`;

const table = (rows: [RowSpec, string][], nameCol = "Defense") =>
  `<table><thead><tr><th></th><th></th><th colspan="2">Fantasy</th></tr><tr><th>${nameCol}</th><th>Owner</th><th>Fan Pts</th><th>% Ros</th></tr></thead><tbody>${rows
    .map(([r, pts]) => row({ ...r, extra: [pts, "40%"] }))
    .join("")}</tbody></table>`;

const DEF_ROWS: [RowSpec, string][] = [
  [{ teamSlug: "cle", name: "Cleveland", teamPos: "Cle - DEF", owner: "FA" }, "7.05"],
  [{ teamSlug: "buf", name: "Buffalo", teamPos: "Buf - DEF", owner: "FA" }, "6.11"],
];

// ------------------------------------------------------------------ findStatsView
test("findStatsView: GET form + named select → action + page params + form fields + select=value; lowest projected week", () => {
  const r = findStatsView(statsForm("Season (2026)"), LIST_VIEW.week, PAGE);
  assert.deepEqual(r.candidates, ["Week 9 (proj)", "Week 8 (proj)"]);
  assert.equal(r.view?.text, "Week 8 (proj)", "the current (lowest) projected week, not the first listed");
  assert.equal(r.view?.how, "form");
  assert.equal(r.view?.field, "stat1");
  assert.equal(r.view?.value, "S_PW_8");
  const u = new URL(r.view!.url);
  assert.equal(u.pathname, "/f1/1405188/players");
  assert.deepEqual(Object.fromEntries(u.searchParams), { status: "A", pos: "DEF", sort: "AR", count: "0", cut_type: "9", stat1: "S_PW_8" });
  assert.ok(!u.searchParams.has("myteam"), "an unchecked box is not submitted");
});

test("findStatsView: a link with the view text wins; an option whose value is a URL is followed as is", () => {
  const link = `<a href="/f1/1405188/players?x=1&amp;view=pw8">Week 8 (proj)</a>` + statsForm("Season (2026)");
  assert.deepEqual(findStatsView(link, LIST_VIEW.week, PAGE).view, { text: "Week 8 (proj)", url: "https://football.fantasysports.yahoo.com/f1/1405188/players?x=1&view=pw8", how: "link" });
  const optUrl = `<select onchange="location=this.value"><option value="/f1/1405188/players?v=a">Season (2026)</option><option value="/f1/1405188/players?v=pw8">Week 8 (proj)</option></select>`;
  assert.deepEqual(findStatsView(optUrl, LIST_VIEW.week, PAGE).view, { text: "Week 8 (proj)", url: "https://football.fantasysports.yahoo.com/f1/1405188/players?v=pw8", how: "option-url" });
});

test("findStatsView: rest-of-season view only from a remaining/rest-of-season text; 'Season (proj)' never counts", () => {
  assert.equal(findStatsView(statsForm(""), LIST_VIEW.ros, PAGE).view?.value, "S_PSR");
  const onlySeason = `<form method="get"><select name="stat1"><option value="S_PS_2026">Season (proj)</option></select></form>`;
  const r = findStatsView(onlySeason, LIST_VIEW.ros, PAGE);
  assert.equal(r.view, undefined);
  assert.match(r.note!, /no matching Stats option/);
});

test("findStatsView: every failed step is a note and no URL (POST form, no form, unnamed select, other league, nothing)", () => {
  const cases: [string, RegExp][] = [
    [statsForm("", { method: "post" }), /form method is post/],
    [`<select name="stat1"><option value="S_PW_8">Week 8 (proj)</option></select>`, /not inside a <form>/],
    [`<form method="get"><select><option value="S_PW_8">Week 8 (proj)</option></select></form>`, /not inside a named <select>/],
    [statsForm("", { action: "https://evil.example/f1/1405188/players" }), /form action is not a same-league URL/],
    [`<a href="/f1/999/players?w=8">Week 8 (proj)</a>`, /link without a same-league href/],
    [`<p>Week 8 (proj)</p>`, /no matching Stats option or link/],
  ];
  for (const [html, note] of cases) {
    const r = findStatsView(html, LIST_VIEW.week, PAGE);
    assert.equal(r.view, undefined, html);
    assert.match(r.note ?? "", note, html);
  }
});

// ------------------------------------------------------------------ parseListProjectionHtml
test("parseListProjectionHtml: Fan Pts read only while the requested view shows as selected (players and DEF)", () => {
  const off: [RowSpec, string][] = [[{ id: "4001", name: "Off Guy", teamPos: "Det - WR", owner: "FA" }, "11.4"]];
  const html = statsForm("Week 8 (proj)") + table(DEF_ROWS) + table(off, "Offense");
  assert.equal(selectedStatsView(html, LIST_VIEW.week), "Week 8 (proj)");
  const r = parseListProjectionHtml(html, "week", "Week 8 (proj)");
  assert.equal(r.defValues.get("CLE"), 7.05);
  assert.equal(r.defValues.get("BUF"), 6.11);
  assert.equal(r.values.get("4001"), 11.4);
  assert.equal(r.diag.column, "Fan Pts");
  assert.equal(r.diag.viewIndicator, "Week 8 (proj)");
  assert.equal(r.diag.note, undefined);
});

test("parseListProjectionHtml: season view selected (Yahoo ignored the param), other week, no Fan Pts, out of range → absent", () => {
  const season = parseListProjectionHtml(statsForm("Season (2026)") + table(DEF_ROWS), "week", "Week 8 (proj)");
  assert.equal(season.defValues.size, 0);
  assert.match(season.diag.note!, /"Week 8 \(proj\)" not shown as selected/);
  const wk9 = parseListProjectionHtml(statsForm("Week 9 (proj)") + table(DEF_ROWS), "week", "Week 8 (proj)");
  assert.equal(wk9.defValues.size, 0);
  assert.match(wk9.diag.note!, /shows "Week 9 \(proj\)"/);
  const noCol = parseListProjectionHtml(statsForm("Week 8 (proj)") + table(DEF_ROWS).replace("Fan Pts", "Yds"), "week", "Week 8 (proj)");
  assert.equal(noCol.diag.note, "no Fan Pts column");
  const big = parseListProjectionHtml(statsForm("Week 8 (proj)") + table([[DEF_ROWS[0][0], "61"], [DEF_ROWS[1][0], "-"]]), "week", "Week 8 (proj)");
  assert.equal(big.defValues.size, 0, "> 60 a week or '-' is never a value");
});

// ------------------------------------------------------------------ the bookmarklet end to end
interface Opts {
  /** Stats control present on the default list pages. */
  form?: boolean;
  /** The projected page shows the requested view as selected (false = Yahoo ignored the param). */
  honour?: boolean;
  log?: string[];
}
const K_ROWS: [RowSpec, string][] = [
  [{ id: "5000", name: "Kick Er0", teamPos: "Bal - K", owner: "FA" }, "9.2"],
  [{ id: "5001", name: "Kick Er1", teamPos: "Bal - K", owner: "W (Thu)" }, "8.4"],
];
const O_ROWS: [RowSpec, string][] = [[{ id: "4001", name: "Off Guy", teamPos: "Det - WR", owner: "FA" }, "11.4"]];
/** Two teams; team 1 rosters a K and a DEF with a "Proj" column (this week); A lists for O / K / DEF, one page each. */
function faRoute(o: Opts = {}): Route {
  const { form = true, honour = true } = o;
  const lists: Record<string, [RowSpec, string][]> = { O: O_ROWS, K: K_ROWS, DEF: DEF_ROWS };
  const roster =
    `<table><tr><th>Pos</th><th>Player</th><th>Proj</th></tr>` +
    `<tr><td>K</td><td><a href="https://sports.yahoo.com/nfl/players/7000">My Kicker</a> <span>Det - K</span></td><td>7.5</td></tr>` +
    `<tr><td>DEF</td><td><a href="https://sports.yahoo.com/nfl/teams/nyj/">New York</a> <span>NYJ - DEF</span></td><td>4.0</td></tr></table>`;
  return (url) => {
    const p = url.pathname;
    if (/\/f1\/1405188\/(1|2)$/.test(p)) return { status: 200, html: `<title>L - Team ${p.slice(-1)} | Yahoo</title>${roster}` };
    if (/\/f1\/1405188\/\d+$/.test(p) || p.endsWith("/settings")) return { status: 404, html: "" };
    if (!p.endsWith("/players")) return { status: 404, html: "" };
    const pos = url.searchParams.get("pos") ?? "";
    if (url.searchParams.get("status") === "W") return { status: 200, html: "<table></table>" };
    if (Number(url.searchParams.get("count") ?? 0) > 0) return { status: 200, html: "<table></table>" };
    const stat = url.searchParams.get("stat1");
    if (stat) o.log?.push(`${pos}?${url.searchParams.toString()}`);
    const rows = lists[pos] ?? [];
    if (stat === "S_PW_8") return { status: 200, html: statsForm(honour ? "Week 8 (proj)" : "Season (2026)") + table(rows) };
    if (stat === "S_PSR") return { status: 200, html: statsForm(honour ? "Remaining Season (proj)" : "Season (2026)") + table(rows.map(([r, v]) => [r, (Number(v) * 9).toFixed(2)])) };
    // Default view: actual points in "Fan Pts" (never to be read as a projection).
    return { status: 200, html: (form ? statsForm("Season (2026)") : "") + table(rows.map(([r]) => [r, "55.5"])) };
  };
}
const fa = (payload: any, name: string) => payload.freeAgents.find((f: any) => f.name === name);

test("bookmarklet v6: available K / DEF / offense get this week's and rest-of-season Yahoo projections from the Stats form", async () => {
  const log: string[] = [];
  const { payload, diagnostics, overlay } = await runBookmarklet(faRoute({ log }));
  assert.equal(fa(payload, "Cleveland").yahooProjWeekly, 7.05);
  assert.equal(fa(payload, "Buffalo").yahooProjWeekly, 6.11);
  assert.equal(fa(payload, "Kick Er0").yahooProjWeekly, 9.2);
  assert.equal(fa(payload, "Kick Er1").yahooProjWeekly, 8.4, "a waiver kicker carries his projection too (the server decides)");
  assert.equal(fa(payload, "Off Guy").yahooProjWeekly, 11.4);
  assert.equal(fa(payload, "Cleveland").yahooProj, 63.45);
  // Exactly the URLs the markup encodes: page params + form fields + stat1=<option value>; K, DEF first, 1 page each.
  assert.deepEqual(log, [
    "K?status=A&pos=K&sort=AR&count=0&cut_type=9&stat1=S_PW_8",
    "K?status=A&pos=K&sort=AR&count=0&cut_type=9&stat1=S_PSR",
    "DEF?status=A&pos=DEF&sort=AR&count=0&cut_type=9&stat1=S_PW_8",
    "DEF?status=A&pos=DEF&sort=AR&count=0&cut_type=9&stat1=S_PSR",
    "O?status=A&pos=O&sort=AR&count=0&cut_type=9&stat1=S_PW_8",
    "O?status=A&pos=O&sort=AR&count=0&cut_type=9&stat1=S_PSR",
  ]);
  const sum = diagnostics.find((d) => d.step === "faProjections" && d.available !== undefined);
  assert.equal(sum.week, 5);
  assert.equal(sum.view, "Week 8 (proj)");
  const perPage = diagnostics.filter((d) => d.step === "faProjections" && d.kind === "week" && d.how);
  assert.equal(perPage.length, 3, "one projected page per list: no more pages than the list itself showed players on");
  assert.ok(perPage.every((d) => d.how === "form" && d.field === "stat1" && d.value === "S_PW_8" && d.viewIndicator === "Week 8 (proj)"));
  assert.match(overlay, /5 available players with this week's projection, 5 rest of season/);
  assert.match(overlay, /Trade Desk import v8/);
  // My rostered DEF (no player id) gets this week's "Proj" via its team, like the kicker.
  const mine = payload.teams[0].players;
  assert.equal(mine.find((p: any) => p.pos === "DEF").yahooProjWeekly, 4);
  assert.equal(mine.find((p: any) => p.pos === "K").yahooProjWeekly, 7.5);
  // The server keeps them.
  const stored = validateImport(payload);
  assert.equal(stored.freeAgents!.find((f) => f.name === "Cleveland")!.yahooProjWeekly, 7.05);
  assert.ok(!((stored.diagnostics as any[]) ?? []).some((d) => d.step === "validate"));
});

test("bookmarklet v6: Yahoo ignoring the view (season still selected) → no projections, a note per page, import completes", async () => {
  const { payload, diagnostics, overlay } = await runBookmarklet(faRoute({ honour: false }));
  for (const f of payload.freeAgents) {
    assert.equal(f.yahooProjWeekly, undefined, f.name);
    assert.equal(f.yahooProj, undefined, f.name);
  }
  assert.ok(diagnostics.filter((d) => d.step === "faProjections" && d.kind === "week" && d.url).every((d) => /not shown as selected/.test(d.note)));
  assert.match(diagnostics.find((d) => d.step === "faProjections" && d.available !== undefined).note, /yahooProjWeekly not captured/);
  assert.match(overlay, /0 available players with this week's projection/);
});

test("bookmarklet v6: no Stats control on the list page → a note naming the step, no extra fetch, projections absent", async () => {
  const log: string[] = [];
  const { payload, diagnostics } = await runBookmarklet(faRoute({ form: false, log }));
  assert.deepEqual(log, [], "nothing guessed, nothing fetched");
  assert.equal(fa(payload, "Cleveland").yahooProjWeekly, undefined);
  const notes = diagnostics.filter((d) => d.step === "faProjections" && d.kind);
  assert.equal(notes.length, 6, "week + ros for each of K, DEF, offense");
  assert.ok(notes.every((d) => /no matching Stats option or link/.test(d.note)));
});

test("bookmarklet v6: the projected page failing to load is recorded; the import still completes", async () => {
  const base = faRoute();
  const { payload, diagnostics } = await runBookmarklet((url) => (url.searchParams.get("stat1") === "S_PW_8" ? "throw" : base(url)));
  assert.equal(fa(payload, "Cleveland").yahooProjWeekly, undefined);
  assert.equal(fa(payload, "Cleveland").yahooProj, 63.45, "the rest-of-season view still read");
  assert.ok(diagnostics.some((d) => d.step === "faProjections" && d.kind === "week" && /fetch failed/.test(d.note ?? "")));
});
