// Anonymized sample for the Matchup tab in `?mock=1` mode (teams "Team A–F", invented players).
import type { MatchupCell, MatchupResponse, RecordGame } from "../../server/model/matchup";

const cell = (name: string, pos: string, nflTeam: string, ours: number | null, yahoo: number | null, points: number | null, o: Partial<MatchupCell> = {}): MatchupCell => ({
  id: name.toLowerCase().replace(/\W/g, "-"), name, pos, nflTeam, ours, yahoo, points, status: null, locked: false, ...o,
});

const A: [string, string, string, number, number, number | null, Partial<MatchupCell>?][] = [
  ["QB", "Qb Alpha", "BUF", 21.4, 20.1, 24.3, { locked: true }],
  ["WR", "Wr Alpha", "MIN", 16.8, 15.2, 18.1, { locked: true }],
  ["WR", "Wr Bravo", "DET", 14.2, 13.9, null],
  ["RB", "Rb Alpha", "SF", 15.6, 16.4, 9.2, { locked: true }],
  ["TE", "Te Alpha", "KC", 11.3, 10.1, null, { status: "Q" }],
  ["W/R/T", "Rb Bravo", "DAL", 12.9, 12.2, 6.4, { locked: true }],
  ["W/R/T", "Wr Charlie", "MIA", 13.5, 14.8, null],
  ["K", "K Alpha", "BAL", 8.4, 8.0, null],
  ["DEF", "Def Alpha", "PHI", 8.3, 7.8, null],
];
const B: typeof A = [
  ["QB", "Qb Bravo", "CIN", 19.8, 20.6, 15.0, { locked: true }],
  ["WR", "Wr Delta", "SEA", 15.1, 15.9, 12.3, { locked: true }],
  ["WR", "Wr Echo", "LAR", 13.7, 12.5, null],
  ["RB", "Rb Charlie", "HOU", 14.8, 14.1, 11.5, { locked: true }],
  ["TE", "Te Bravo", "GB", 9.6, 9.0, null],
  ["W/R/T", "Rb Delta", "ATL", 11.9, 12.8, null, { status: "O" }],
  ["W/R/T", "Wr Foxtrot", "LAC", 12.2, 11.6, null],
  ["K", "K Bravo", "DEN", 7.9, 8.2, null],
  ["DEF", "Def Bravo", "NYJ", 7.2, 7.4, null],
];

const sum = (xs: (number | null)[]) => Math.round(xs.reduce<number>((t, x) => t + (x ?? 0), 0) * 10) / 10;
const pts = (xs: typeof A) => sum(xs.map((r) => r[5]));

function game(mine: boolean, teams: [string, string], ours: [number | null, number | null], yahoo: [number, number], points: [number, number], captured = true): RecordGame {
  const call = (p: [number | null, number | null]) => (p[0] == null || p[1] == null || p[0] === p[1] ? null : p[0] > p[1] === points[0] > points[1]);
  return { teams, mine, ours, yahoo, yahooPage: yahoo, oursMissing: (ours[0] == null && ours[1] == null && !captured ? [0, 0] : ours.map((x) => (x == null ? 2 : 0))) as [number, number], yahooMissing: [0, 0], points, oursCall: call(ours), yahooCall: call(yahoo) };
}

export function mockMatchup(week?: number): MatchupResponse {
  const w = week ?? 8;
  const live = w === 8;
  const oursA = sum(A.map((r) => r[3]));
  const oursB = sum(B.map((r) => r[3]));
  const side = (teamId: string, name: string, record: string, ours: number, yahoo: number, points: number | null, winPct: number) => ({
    teamId, name, record, ours, oursIncomplete: 0, oursPartial: ours, yahoo, yahooOrig: yahoo, yahooLive: live ? yahoo + 21.6 : null, oursLive: live ? ours + 18.2 : null, points: live ? points : points == null ? null : points + 52.3, winPct,
  });
  const rows = A.map((a, i) => ({ slot: a[0], a: cell(a[1], a[0], a[2], a[3], a[4], live ? a[5] : null, a[6]), b: cell(B[i][1], B[i][0], B[i][2], B[i][3], B[i][4], live ? B[i][5] : null, B[i][6]) }));
  const bench = [
    { slot: "BN", a: cell("Wr Golf", "WR", "CHI", 9.1, 8.7, null), b: cell("Rb Echo", "RB", "NO", 8.4, 8.8, null) },
    { slot: "BN", a: cell("Rb Foxtrot", "RB", "TB", 7.2, 6.9, null), b: null },
  ];
  // Other pairings: the same rows / bench shape as mine, from the import (per-player points unknown → null). `noOurs`
  // starters per side have no projection of ours (e.g. a Thursday game before the first capture); `locked` = Yahoo's
  // pre-game total was captured (else only Yahoo's live total, as in a week first captured after Thursday).
  const other = (n1: string, n2: string, id1: string, id2: string, noOurs: [number, number], locked: boolean): MatchupResponse["others"][number] => {
    type Row = [string, string, string, number | null, number, number | null, Partial<MatchupCell>?];
    const unproj = (xs: typeof A, n: number): Row[] => xs.map((r, i) => [r[0], r[1], r[2], i < n ? null : r[3], r[4], r[5], r[6]]);
    const xa = unproj(A, noOurs[0]);
    const xb = unproj(B, noOurs[1]);
    const mk = (r: (typeof xa)[number], tag: string) => cell(`${r[1]} ${tag}`, r[0], r[2], r[3], r[4], null, { ...r[6], locked: r[3] === null || !!r[6]?.locked });
    const total = (xs: typeof xa) => {
      const n = xs.filter((r) => r[3] === null).length;
      const partial = sum(xs.map((r) => r[3]));
      return { ours: n ? null : partial, oursIncomplete: n, oursPartial: n === xs.length ? null : partial };
    };
    const ta = total(xa);
    const tb = total(xb);
    const win = ta.ours != null && tb.ours != null ? (ta.ours > tb.ours ? 0.55 : 0.45) : null;
    const sideO = (teamId: string, name: string, t: typeof ta, yahoo: number, pts: number, winPct: number | null) => ({
      teamId, name, record: "4-3", ...t, yahoo: locked ? yahoo : null, yahooOrig: yahoo + 3.1, yahooLive: null, oursLive: null, points: live ? pts : pts + 70, winPct,
    });
    return {
      sides: [sideO(id1, n1, ta, 118.4, 31.2, win), sideO(id2, n2, tb, 112.9, 27.8, win == null ? null : 1 - win)],
      lineupSource: "import",
      rows: xa.map((r, i) => ({ slot: r[0], a: mk(r, id1), b: mk(xb[i], id2) })),
      bench: [{ slot: "BN", a: cell(`Wr Golf ${id1}`, "WR", "CHI", 9.1, 8.7, null), b: cell(`Rb Echo ${id2}`, "RB", "NO", 8.4, 8.8, null) }],
    };
  };
  return {
    week: w, currentWeek: 8, weeks: [8, 7, 6], status: live ? "live" : "final", asOf: "2026-10-31T19:00:00Z",
    teams: { "1": "Team A", "2": "Team B", "3": "Team C", "4": "Team D", "5": "Team E", "6": "Team F" },
    mine: {
      lineupSource: "page",
      sides: [side("1", "Team A", "5-2", oursA, 120.4, pts(A), 0.6), side("2", "Team B", "4-3", oursB, 118.9, pts(B), 0.4)],
      rows, bench,
    },
    others: [other("Team C", "Team D", "3", "4", [0, 0], true), other("Team E", "Team F", "5", "6", [1, 0], false)],
    record: {
      weeks: [
        { week: 7, recorded: true, games: [game(true, ["1", "2"], [128.4, 121.0], [131.8, 121.1], [165.8, 123.9]), game(false, ["3", "4"], [110.2, 114.0], [112.0, 111.3], [98.4, 120.6])] },
        { week: 6, recorded: true, games: [game(true, ["3", "1"], [null, 118.7], [109.5, 116.2], [101.7, 109.2])] },
        { week: 5, recorded: false, games: [game(true, ["1", "4"], [null, null], [122.0, 115.0], [131.5, 101.9], false)] },
      ],
      summary: { games: 3, oursCalls: 2, yahooCalls: 2, teamWeeks: 6, oursMae: 14.2, yahooMae: 15.6, oursBias: 6.1, yahooBias: 4.4 },
    },
  };
}
