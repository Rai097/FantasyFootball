// League tab (docs/DESIGN.md "League tab", "League tab modes"): power-score chart, standings table, and "who is above me
// and why" as collapsed rows (summary line → mini chart + bullets on tap). Two modes: Now (power score) and Playoffs
// (playoff strength, weeks 15–17: pure projection, no results or record).
import { useState } from "react";
import { api, type Active, type Analysis } from "../api";
import type { LeagueTeamRow, LeagueView, PlayoffComparison, TeamComparison } from "../../../server/model/league";
import type { AccuracyResponse, PlayerAccuracy } from "../../../server/model/projLog";
import { ErrorBox, Loading, Stat, Why } from "../components/common";
import { ColumnHelp } from "../components/HelpTip";
import { DetailList, ExpandableList, ExpandableRow, type DetailLine } from "../components/ExpandableRow";
import { deltaClass, f1, ordinal, signed } from "../lib/format";
import { useAsync } from "../lib/useAsync";

const TIPS = {
  power: "Team strength: 0.7 × projected starter ppg + 0.3 × actual points per game this season. Bench breaks ties.",
  starter: "Points per game your best healthy lineup (IR slot excluded) is projected to score from this week on.",
  results: "Actual fantasy points per game this season (points for ÷ games). Unknown → the projection stands in.",
  bench: "Points per game above a waiver player, summed over the 3 best playable bench players. Only breaks ties.",
  unknown: "Results unknown: no points-for in the standings, so this team is ranked on projected starters only.",
  rank: "Standings place by record, then points scored (Yahoo's own rank when the import has it).",
  record: "Wins-losses (-ties) from the league standings at the last update.",
  pf: "Points for: total fantasy points this team has scored this season.",
  pa: "Points against: total points opponents scored against this team this season.",
  pwr: "Power rank: place by power score (1 = strongest roster).",
  gap: "Their power score minus yours: how far ahead (+) or behind (−) they are.",
  playoff: "Playoff strength: projected points per week of the best lineup in the playoff weeks + 0.25 × bench cover. Results and record play no part.",
  poLineup: "Points per week the best lineup is projected to score in the playoff weeks (byes, injuries and returns counted).",
  poDepth: "Points per week the bench recovers when one starter is out in the playoffs.",
  poRank: "Playoff rank: place by playoff strength (1 = strongest playoff roster).",
  poGap: "Their playoff strength minus yours, points per week.",
};

type Mode = "now" | "playoffs";

export function LeagueTab({ active }: { analysis: Analysis; active: Active & { team: string } }) {
  const res = useAsync(() => api.leagueView(active), [active.provider, active.id, active.team]);
  if (res.error) return <ErrorBox error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading label="Ranking the league…" />;
  return (
    <>
      <LeagueBody v={res.data} />
      {active.provider === "import" && <AccuracyCard active={active} />}
    </>
  );
}

function LeagueBody({ v }: { v: LeagueView }) {
  const playoffsOk = v.playoffWeeks.length > 0 && v.teams.some((t) => t.mine && t.playoff);
  const [picked, setMode] = useState<Mode>("now");
  const mode: Mode = playoffsOk ? picked : "now";
  const weeks = playoffsOk ? `wks ${v.playoffWeeks[0]}–${v.playoffWeeks[v.playoffWeeks.length - 1]}` : "";
  return (
    <div className="stack">
      <div className="row gap">
        <div className="seg" role="radiogroup" aria-label="Rank teams by">
          <button role="radio" aria-checked={mode === "now"} className={`seg-btn ${mode === "now" ? "active" : ""}`} onClick={() => setMode("now")} title={TIPS.power}>
            Now
          </button>
          <button
            role="radio"
            aria-checked={mode === "playoffs"}
            disabled={!playoffsOk}
            className={`seg-btn ${mode === "playoffs" ? "active" : ""}`}
            onClick={() => setMode("playoffs")}
            title={playoffsOk ? TIPS.playoff : "No playoff weeks left to project."}
          >
            Playoffs{weeks && ` (${weeks})`}
          </button>
        </div>
        <Why text={mode === "now" ? TIPS.power : TIPS.playoff} />
      </div>
      {mode === "now" ? <NowView v={v} /> : <PlayoffView v={v} />}
    </div>
  );
}

function NowView({ v }: { v: LeagueView }) {
  const me = v.teams.find((t) => t.mine)!;
  const n = v.numTeams;
  return (
    <>
      <section className="stat-row" title={v.summary}>
        <Stat label="Power rank" value={ordinal(me.powerRank)} sub={`of ${n}`} why={TIPS.pwr} />
        <Stat label="Standings" value={me.standingsRank != null ? ordinal(me.standingsRank) : "—"} sub={me.record !== "—" ? me.record : "not captured"} why={TIPS.rank} />
        <Stat
          label="Power score"
          value={f1(me.powerScore)}
          sub={`${f1(me.projectedPart)} + ${f1(me.resultsPart)}${me.resultsPpg == null ? " (results unknown)" : ""}`}
          why={TIPS.power}
        />
        <Stat label="Teams above" value={String(v.above.length)} sub="by power" why="Teams with a higher power score than yours; tap a row below for why." />
      </section>

      <div className="grid-league">
        <section className="card">
          <h2 className="row between">
            <span>Power rankings</span>
            <Why text={TIPS.power} />
          </h2>
          {v.resultsUnknown > 0 && (
            <div className="notice warn small">
              Results unknown for {v.resultsUnknown} of {n} teams: ranked on projected starters only. Re-import standings.
            </div>
          )}
          <PowerChart teams={v.teams} />
        </section>

        <section className="card">
          <h2>Standings</h2>
          {!v.standingsKnown && <div className="notice warn small">Standings not captured: re-import with the latest bookmarklet.</div>}
          <StandingsTable teams={v.teams} mode="now" />
        </section>
      </div>

      <section className="card flush">
        <h2 className="card-title">Who's above you <span className="muted small">{v.above.length}</span></h2>
        {v.above.length ? (
          <CompareList rows={v.above} label="Teams above you" />
        ) : (
          <p className="muted small card-title">Nobody: you have the top power score.</p>
        )}
      </section>

      {v.below.length > 0 && (
        <section className="card flush">
          <h2 className="card-title">Below you <span className="muted small">{v.below.length}</span></h2>
          <CompareList rows={v.below} label="Teams below you" />
        </section>
      )}
    </>
  );
}

function PlayoffView({ v }: { v: LeagueView }) {
  const me = v.teams.find((t) => t.mine)!;
  const po = me.playoff!;
  const n = v.numTeams;
  return (
    <>
      <section className="stat-row">
        <Stat label="Playoff rank" value={ordinal(po.rank)} sub={`of ${n}`} why={TIPS.poRank} />
        <Stat label="Standings" value={me.standingsRank != null ? ordinal(me.standingsRank) : "—"} sub={me.record !== "—" ? me.record : "not captured"} why={TIPS.rank} />
        <Stat label="Playoff strength" value={f1(po.total)} sub={`lineup ${f1(po.lineup)} + bench cover ${f1(po.depth)}`} why={TIPS.playoff} />
        <Stat label="Teams above" value={String(v.playoffAbove.length)} sub="in the playoffs" why="Teams with a higher playoff strength than yours; tap a row below for why." />
      </section>

      <div className="grid-league">
        <section className="card">
          <h2 className="row between">
            <span>Playoff rankings</span>
            <Why text={TIPS.playoff} />
          </h2>
          <PlayoffChart teams={v.teams} depthWeight={v.depthWeight} />
        </section>

        <section className="card">
          <h2>Standings</h2>
          {!v.standingsKnown && <div className="notice warn small">Standings not captured: re-import with the latest bookmarklet.</div>}
          <StandingsTable teams={v.teams} mode="playoffs" />
        </section>
      </div>

      <section className="card flush">
        <h2 className="card-title">Stronger in the playoffs <span className="muted small">{v.playoffAbove.length}</span></h2>
        {v.playoffAbove.length ? (
          <PlayoffCompareList rows={v.playoffAbove} label="Teams stronger in the playoffs" />
        ) : (
          <p className="muted small card-title">Nobody: you have the strongest playoff roster.</p>
        )}
      </section>

      {v.playoffBelow.length > 0 && (
        <section className="card flush">
          <h2 className="card-title">Weaker in the playoffs <span className="muted small">{v.playoffBelow.length}</span></h2>
          <PlayoffCompareList rows={v.playoffBelow} label="Teams weaker in the playoffs" />
        </section>
      )}
    </>
  );
}

/** Stacked bars: playoff lineup + 0.25 × bench cover = playoff strength; axis starts below the lowest lineup (like PowerChart). */
function PlayoffChart({ teams, depthWeight }: { teams: LeagueTeamRow[]; depthWeight: number }) {
  const rows = teams.filter((t) => t.playoff).sort((a, b) => a.playoff!.rank - b.playoff!.rank);
  const max = Math.max(...rows.map((t) => t.playoff!.total), 1);
  const minLineup = Math.min(...rows.map((t) => t.playoff!.lineup));
  const base = Math.max(0, Math.floor((minLineup - (max - minLineup) * 0.15) / 5) * 5);
  const span = Math.max(max - base, 1);
  return (
    <div className="lg-chart" role="table" aria-label="Playoff strength by team">
      <div className="lg-legend muted small">
        <i className="sw projected" /> playoff lineup pts/wk <Why text={TIPS.poLineup} />
        <i className="sw results" /> {depthWeight} × bench cover <Why text={TIPS.poDepth} />
      </div>
      <div className="lg-chart-row lg-chart-head" role="row">
        <span>#</span>
        <span>Team</span>
        <span>Lineup + bench cover <span className="muted small">(axis from {base})</span></span>
        <span className="num">Score</span>
      </div>
      {rows.map((t) => {
        const p = t.playoff!;
        const cover = Math.max(0, p.total - p.lineup);
        return (
          <div
            key={t.id}
            role="row"
            className={`lg-chart-row${t.mine ? " mine" : ""}`}
            title={`${t.name}: ${f1(p.total)} = ${f1(p.lineup)} lineup + ${f1(cover)} (${depthWeight} × ${f1(p.depth)} bench cover) pts/wk`}
          >
            <span className="muted">{p.rank}</span>
            <span className={`lg-name${t.mine ? " strong" : ""}`}>{t.name}</span>
            <span className="lg-bar" aria-hidden>
              <span className="seg projected" style={{ width: `${(Math.max(0, p.lineup - base) / span) * 100}%` }} />
              {cover > 0 && <span className="seg results" style={{ width: `${(cover / span) * 100}%` }} />}
            </span>
            <span className="num strong">{f1(p.total)}</span>
          </div>
        );
      })}
    </div>
  );
}

function PlayoffCompareList({ rows, label }: { rows: PlayoffComparison[]; label: string }) {
  return (
    <ExpandableList
      label={label}
      className="lg-list"
      header={
        <>
          <span>Team</span>
          <span>Why</span>
          <span className="num" title={TIPS.poGap}>
            Gap
          </span>
        </>
      }
    >
      {rows.map((c) => (
        <PlayoffCompareRow key={c.teamId} c={c} />
      ))}
    </ExpandableList>
  );
}

function PlayoffCompareRow({ c }: { c: PlayoffComparison }) {
  const details: DetailLine[] = [
    { label: "Playoff strength gap", value: `${signed(c.gap)} pts/wk`, tone: tone(c.gap), title: TIPS.poGap },
    { label: "Playoff lineup", value: `${signed(c.lineupGap)} pts/wk`, tone: tone(c.lineupGap), title: TIPS.poLineup },
    { label: "Bench cover", value: `${signed(c.depthGap)} pts/wk`, tone: tone(c.depthGap), title: TIPS.poDepth },
    { label: "Power rank now", value: ordinal(c.powerRank), title: TIPS.pwr },
    { label: "Standings", value: c.standingsRank != null ? `${ordinal(c.standingsRank)} (${c.record})` : "—", title: TIPS.rank },
  ];
  return (
    <ExpandableRow
      className="lg-row"
      label={c.name}
      head={
        <>
          <span className="lg-team">
            <span className="lg-rank">{c.rank}</span>
            <span className="strong lg-name">{c.name}</span>
          </span>
          <span className="lg-summary">{c.summary}</span>
          <span className={`num lg-gap delta ${deltaClass(c.gap)}`} title={TIPS.poGap}>
            {signed(c.gap)}
          </span>
        </>
      }
    >
      <DetailList items={details} />
    </ExpandableRow>
  );
}

/**
 * Horizontal stacked bars: projected part + results part = power score. Scores sit close together, so the axis starts
 * just below the lowest projected part (a round number, labelled) instead of 0, making the real gaps visible. A results
 * part that is only the projection standing in (results unknown) is drawn faded.
 */
function PowerChart({ teams }: { teams: LeagueTeamRow[] }) {
  const max = Math.max(...teams.map((t) => t.projectedPart + t.resultsPart), 1);
  const minProjected = Math.min(...teams.map((t) => t.projectedPart));
  const base = Math.max(0, Math.floor((minProjected - (max - minProjected) * 0.15) / 5) * 5);
  const span = Math.max(max - base, 1);
  return (
    <div className="lg-chart" role="table" aria-label="Power score by team">
      <div className="lg-legend muted small">
        <i className="sw projected" /> 0.7 × projected starter ppg <Why text={TIPS.starter} />
        <i className="sw results" /> 0.3 × actual pts/game <Why text={TIPS.results} />
      </div>
      <div className="lg-chart-row lg-chart-head" role="row">
        <span>#</span>
        <span>Team</span>
        <span>Projected + results <span className="muted small">(axis from {base})</span></span>
        <span className="num">Score</span>
      </div>
      {teams.map((t) => (
        <div
          key={t.id}
          role="row"
          className={`lg-chart-row${t.mine ? " mine" : ""}`}
          title={`${t.name}: ${f1(t.powerScore)} = ${f1(t.projectedPart)} projected (0.7 × ${f1(t.starterPpg)}) + ${f1(t.resultsPart)} results (0.3 × ${
            t.resultsPpg != null ? `${f1(t.resultsPpg)} actual pts/game` : `${f1(t.starterPpg)}: results unknown`
          })`}
        >
          <span className="muted">{t.powerRank}</span>
          <span className={`lg-name${t.mine ? " strong" : ""}`}>{t.name}</span>
          <span className="lg-bar" aria-hidden>
            <span className="seg projected" style={{ width: `${(Math.max(0, t.projectedPart - base) / span) * 100}%` }} />
            {t.resultsPart > 0 && (
              <span className={`seg results${t.resultsPpg == null ? " est" : ""}`} style={{ width: `${(t.resultsPart / span) * 100}%` }} />
            )}
          </span>
          <span className="num strong">{f1(t.powerScore)}</span>
        </div>
      ))}
    </div>
  );
}

function StandingsTable({ teams, mode }: { teams: LeagueTeamRow[]; mode: Mode }) {
  const rows = [...teams].sort((a, b) => (a.standingsRank ?? 99) - (b.standingsRank ?? 99) || a.powerRank - b.powerRank);
  const H = ({ label, tip, cls = "" }: { label: string; tip: string; cls?: string }) => (
    <th className={`num ${cls}`.trim()}>
      <ColumnHelp tip={tip}>{label}</ColumnHelp>
    </th>
  );
  return (
    <div className="table-wrap">
      <table className="table lg-standings">
        <thead>
          <tr>
            <H label="#" tip={TIPS.rank} />
            <th>Team</th>
            <H label="W-L" tip={TIPS.record} />
            <H label="PF" tip={TIPS.pf} />
            <H label="PA" tip={TIPS.pa} cls="hide-sm" />
            {mode === "now" ? <H label="Pwr" tip={TIPS.pwr} /> : <H label="PO" tip={TIPS.poRank} />}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className={t.mine ? "mine" : ""}>
              <td className="num">{t.standingsRank ?? "—"}</td>
              <td className="lg-name strong">{t.name}</td>
              <td className="num">{t.record}</td>
              <td className="num">{t.pointsFor != null ? f1(t.pointsFor) : "—"}</td>
              <td className="num hide-sm">{t.pointsAgainst != null ? f1(t.pointsAgainst) : "—"}</td>
              <td className="num">{mode === "now" ? t.powerRank : (t.playoff?.rank ?? "—")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompareList({ rows, label }: { rows: TeamComparison[]; label: string }) {
  return (
    <ExpandableList
      label={label}
      className="lg-list"
      header={
        <>
          <span>Team</span>
          <span>Why</span>
          <span className="num" title={TIPS.gap}>
            Gap
          </span>
        </>
      }
    >
      {rows.map((c) => (
        <CompareRow key={c.teamId} c={c} />
      ))}
    </ExpandableList>
  );
}

function CompareRow({ c }: { c: TeamComparison }) {
  const details: DetailLine[] = [
    {
      label: "Power gap",
      value: `${signed(c.powerGap)} (projected ${signed(c.projectedPartGap)}, results ${signed(c.resultsPartGap)})`,
      tone: tone(c.powerGap),
      title: TIPS.gap,
    },
    { label: "Projected starters", value: `${signed(c.starterGap)} pts/wk`, tone: tone(c.starterGap), title: TIPS.starter },
    c.resultsGap != null
      ? { label: "Actual pts/game", value: signed(c.resultsGap), tone: tone(c.resultsGap), title: TIPS.results }
      : { label: "Actual pts/game", value: "Results unknown — re-import standings", title: TIPS.unknown },
    { label: "Bench depth", value: `${signed(c.benchGap)}, tie-breaker only`, title: TIPS.bench },
    ...c.keyPlayers.map((k) => ({
      label: `Their ${k.group} (${signed(k.gap)})`,
      value: k.players.map((p) => `${p.name} ${f1(p.ppg)}`).join(", ") || "—",
      title: `Their top ${k.group} starters and projected points per game; they out-score you here by ${f1(k.gap)} per week.`,
    })),
    {
      label: "Standings",
      value: c.standingsRank != null ? `${ordinal(c.standingsRank)} (${c.record})` : "—",
      title: TIPS.rank,
    },
  ];
  return (
    <ExpandableRow
      className="lg-row"
      label={c.name}
      head={
        <>
          <span className="lg-team">
            <span className="lg-rank">{c.powerRank}</span>
            <span className="strong lg-name">{c.name}</span>
          </span>
          <span className="lg-summary">{c.summary}</span>
          <span className={`num lg-gap delta ${deltaClass(c.powerGap)}`} title={TIPS.gap}>
            {signed(c.powerGap)}
          </span>
        </>
      }
    >
      <GroupBars c={c} />
      <DetailList items={details} />
    </ExpandableRow>
  );
}

const tone = (x: number): DetailLine["tone"] => (x > 0.05 ? "pos" : x < -0.05 ? "neg" : undefined);

/** Mini grouped bars: their starter ppg vs mine per position group (one shared scale from zero). */
function GroupBars({ c }: { c: TeamComparison }) {
  const max = Math.max(...c.groups.flatMap((g) => [g.theirs, g.mine]), 1);
  return (
    <div className="lg-groups" role="table" aria-label={`Starter points per game by position: ${c.name} vs you`}>
      <div className="lg-groups-legend muted small">
        <i className="sw them" /> {c.name} <i className="sw me" /> you
        <Why text="Projected starter points per game in each lineup group; the number is their lead (+) or deficit (−)." />
      </div>
      {c.groups.map((g) => (
        <div key={g.group} className="lg-group" role="row" title={`${g.group}: ${f1(g.theirs)} vs your ${f1(g.mine)} pts/wk`}>
          <span className="lg-glabel">{g.group}</span>
          <span className="lg-gbars" aria-hidden>
            <span className="gbar them" style={{ width: `${(g.theirs / max) * 100}%` }} />
            <span className="gbar me" style={{ width: `${(g.mine / max) * 100}%` }} />
          </span>
          <span className={`num small delta ${deltaClass(g.gap)}`}>{signed(g.gap)}</span>
        </div>
      ))}
    </div>
  );
}


// ---------------------------------------------------------------- projection accuracy (DESIGN.md "Projection accuracy log")
const ACC = {
  mae: "Average miss: mean of |actual − projected| points per player-week, over weeks where both the app and Yahoo had a projection.",
  bias: "Average actual − projected points: positive = the projection ran low (players beat it), negative = it ran high.",
  n: "Player-weeks compared: captured before kickoff, played, and projected by both the app and Yahoo.",
  weeks: "NFL weeks with at least one compared player-week.",
  vsYahoo: "His average actual points minus Yahoo's weekly projection, over the weeks compared (3 or more).",
  beat: "Weeks he scored more than Yahoo projected, of the weeks compared.",
  teamApp: "Projected points per week of this team's skill starters (QB/RB/WR/TE, K and DEF excluded) by the app.",
  teamYahoo: "The same starters' Yahoo projection per week.",
  teamActual: "The same starters' actual points per week; starters who did not play or had no Yahoo number are left out of all three.",
  empty: "Each import before kickoff records both projections for the week; accuracy shows once those games are final and their stats are in.",
};

function AccuracyCard({ active }: { active: Active }) {
  const res = useAsync(() => api.accuracy(active), [active.provider, active.id]);
  if (res.error) return <ErrorBox error={res.error} onRetry={res.reload} />;
  if (!res.data) return null;
  const a = res.data;
  return (
    <section className="card flush acc-card">
      {a.season.n === 0 ? (
        <div className="acc-empty">
          <h2 className="acc-title">Projection accuracy</h2>
          <p className="muted small" title={ACC.empty}>
            Starts after the first imported week is played (import before kickoff each week).
          </p>
        </div>
      ) : (
        <ExpandableRow
          className="acc-row"
          label="Projection accuracy"
          head={
            <>
              <span className="acc-title strong">Projection accuracy</span>
              <span className="acc-key">
                App off by <b title={ACC.mae}>{f1(a.season.appMae)}</b> pts/player-wk, Yahoo <b title={ACC.mae}>{f1(a.season.yahooMae)}</b> (
                <span title={ACC.n}>{a.season.n} player-weeks</span>, <span title={ACC.weeks}>{weekSpan(a.weeks)}</span>)
              </span>
            </>
          }
        >
          <AccuracyDetails a={a} />
        </ExpandableRow>
      )}
    </section>
  );
}

const weekSpan = (w: number[]) => (w.length === 1 ? `wk ${w[0]}` : `wks ${w[0]}–${w[w.length - 1]}`);

function AccuracyDetails({ a }: { a: AccuracyResponse }) {
  const H = ({ label, tip, rowSpan }: { label: string; tip: string; rowSpan?: number }) => (
    <th className="num" rowSpan={rowSpan}>
      <ColumnHelp tip={tip}>{label}</ColumnHelp>
    </th>
  );
  const rows = [...a.byPos.map((p) => ({ key: p.pos, ...p })), { key: "All", ...a.season }];
  return (
    <div className="acc-details">
      <div className="table-wrap">
        <table className="table acc-table" aria-label="Projection error by position">
          <thead>
            <tr>
              <th rowSpan={2}>Pos</th>
              <H label="N" tip={ACC.n} rowSpan={2} />
              <th colSpan={2} className="num acc-group">
                <ColumnHelp tip={ACC.mae}>Avg miss</ColumnHelp>
              </th>
              <th colSpan={2} className="num acc-group">
                <ColumnHelp tip={ACC.bias}>Bias</ColumnHelp>
              </th>
            </tr>
            <tr>
              <th className="num" title={ACC.mae}>App</th>
              <th className="num" title={ACC.mae}>Yahoo</th>
              <th className="num" title={ACC.bias}>App</th>
              <th className="num" title={ACC.bias}>Yahoo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={r.key === "All" ? "strong" : ""}>
                <td>{r.key}</td>
                <td className="num" title={ACC.n}>{r.n}</td>
                <td className={`num ${r.appMae < r.yahooMae ? "acc-better" : ""}`} title={ACC.mae}>{f1(r.appMae)}</td>
                <td className={`num ${r.yahooMae < r.appMae ? "acc-better" : ""}`} title={ACC.mae}>{f1(r.yahooMae)}</td>
                <td className="num" title={ACC.bias}>{signed(r.appBias)}</td>
                <td className="num" title={ACC.bias}>{signed(r.yahooBias)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="acc-lists">
        <PlayerList title="Most beat Yahoo" rows={a.mostBeat} />
        <PlayerList title="Most missed Yahoo" rows={a.mostMissed} />
      </div>
      {a.teams.length > 0 && (
        <div className="table-wrap">
          <table className="table acc-table" aria-label="Starters projected vs actual per week">
            <thead>
              <tr>
                <th>Starters per wk</th>
                <H label="App" tip={ACC.teamApp} />
                <H label="Yahoo" tip={ACC.teamYahoo} />
                <H label="Actual" tip={ACC.teamActual} />
              </tr>
            </thead>
            <tbody>
              {a.teams.map((t) => (
                <tr key={t.teamId}>
                  <td className="lg-name" title={`${t.weeks} wk${t.weeks === 1 ? "" : "s"}; left out: ${t.dnp} did not play, ${t.noYahoo} without a Yahoo number`}>{t.name}</td>
                  <td className="num" title={ACC.teamApp}>{f1(t.app)}</td>
                  <td className="num" title={ACC.teamYahoo}>{f1(t.yahoo)}</td>
                  <td className="num" title={ACC.teamActual}>{f1(t.actual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DetailList
        items={[
          { label: "Did not play", value: `${a.counts.dnp} player-weeks, left out`, title: "Captured players with no stats after their game was final: inactive, never scored as 0." },
          { label: "No Yahoo number", value: `${a.counts.noYahoo} player-weeks, app-only`, title: "Played, but Yahoo's weekly projection was not captured that week: kept out of the comparison." },
          { label: "Waiting for results", value: `${a.counts.pending} player-weeks`, title: "Games not final yet, or their weekly stats are not in yet." },
        ]}
      />
    </div>
  );
}

function PlayerList({ title, rows }: { title: string; rows: PlayerAccuracy[] }) {
  return (
    <div className="acc-list">
      <h3 className="small muted">{title}</h3>
      {rows.length ? (
        <ul>
          {rows.map((p) => (
            <li key={p.id} title={`${p.name}: actual − Yahoo ${signed(p.vsYahoo)}, actual − app ${signed(p.vsApp)} pts/wk over ${p.weeks} weeks`}>
              <span className="lg-name">
                {p.name} <span className="muted small">{p.pos}</span>
              </span>
              <span className={`num delta ${deltaClass(p.vsYahoo)}`} title={ACC.vsYahoo}>
                {signed(p.vsYahoo)}
              </span>
              <span className="muted small num" title={ACC.beat}>
                {p.beatYahoo}/{p.weeks}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">— (needs 3 compared weeks)</p>
      )}
    </div>
  );
}
