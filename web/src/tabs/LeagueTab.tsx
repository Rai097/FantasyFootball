// League tab (docs/DESIGN.md "League tab"): power-score chart, standings table, and "who is above me and why" as
// collapsed rows (summary line → mini chart + bullets on tap).
import { api, type Active, type Analysis } from "../api";
import type { LeagueTeamRow, TeamComparison } from "../../../server/model/league";
import { ErrorBox, Loading, Stat, Why } from "../components/common";
import { DetailList, ExpandableList, ExpandableRow, type DetailLine } from "../components/ExpandableRow";
import { deltaClass, f1, ordinal, signed } from "../lib/format";
import { useAsync } from "../lib/useAsync";

const TIPS = {
  power: "Overall team strength: 0.7 × starter ppg + 0.3 × bench strength. Higher = better team on paper.",
  starter: "Points per game your best healthy lineup is projected to score this week and on.",
  bench: "Points per game above a waiver-wire player, summed over your 3 best playable bench players.",
  rank: "Standings place by record, then points scored (Yahoo's own rank when the import has it).",
  record: "Wins-losses (-ties) from the league standings at the last update.",
  pf: "Points for: total fantasy points this team has scored this season.",
  pa: "Points against: total points opponents scored against this team this season.",
  pwr: "Power rank: place by power score (1 = strongest roster).",
  gap: "Their power score minus yours: how far ahead (+) or behind (−) they are.",
};

export function LeagueTab({ active }: { analysis: Analysis; active: Active & { team: string } }) {
  const res = useAsync(() => api.leagueView(active), [active.provider, active.id, active.team]);
  if (res.error) return <ErrorBox error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading label="Ranking the league…" />;
  const v = res.data;
  const me = v.teams.find((t) => t.mine)!;
  const n = v.numTeams;

  return (
    <div className="stack">
      <section className="stat-row" title={v.summary}>
        <Stat label="Power rank" value={ordinal(me.powerRank)} sub={`of ${n}`} why={TIPS.pwr} />
        <Stat label="Standings" value={me.standingsRank != null ? ordinal(me.standingsRank) : "—"} sub={me.record !== "—" ? me.record : "not captured"} why={TIPS.rank} />
        <Stat label="Power score" value={f1(me.powerScore)} sub={`${f1(me.starterPart)} + ${f1(me.benchPart)}`} why={TIPS.power} />
        <Stat label="Teams above" value={String(v.above.length)} sub="by power" why="Teams with a higher power score than yours; tap a row below for why." />
      </section>

      <div className="grid-league">
        <section className="card">
          <h2 className="row between">
            <span>Power rankings</span>
            <Why text={TIPS.power} />
          </h2>
          <PowerChart teams={v.teams} />
        </section>

        <section className="card">
          <h2>Standings</h2>
          {!v.standingsKnown && <div className="notice warn small">Standings not captured: re-import with the latest bookmarklet.</div>}
          <StandingsTable teams={v.teams} />
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
    </div>
  );
}

/**
 * Horizontal stacked bars: starter part + bench part = power score. Scores sit close together (e.g. 68–79), so the axis
 * starts just below the lowest starter part (a round number, labelled) instead of 0, making the real gaps visible.
 */
function PowerChart({ teams }: { teams: LeagueTeamRow[] }) {
  const max = Math.max(...teams.map((t) => t.starterPart + t.benchPart), 1);
  const minStarter = Math.min(...teams.map((t) => t.starterPart));
  const base = Math.max(0, Math.floor((minStarter - (max - minStarter) * 0.15) / 5) * 5);
  const span = Math.max(max - base, 1);
  return (
    <div className="lg-chart" role="table" aria-label="Power score by team">
      <div className="lg-legend muted small">
        <i className="sw starter" /> 0.7 × starter ppg <Why text={TIPS.starter} />
        <i className="sw bench" /> 0.3 × bench strength <Why text={TIPS.bench} />
      </div>
      <div className="lg-chart-row lg-chart-head" role="row">
        <span>#</span>
        <span>Team</span>
        <span>Starters + bench <span className="muted small">(axis from {base})</span></span>
        <span className="num">Score</span>
      </div>
      {teams.map((t) => (
        <div
          key={t.id}
          role="row"
          className={`lg-chart-row${t.mine ? " mine" : ""}`}
          title={`${t.name}: ${f1(t.powerScore)} = ${f1(t.starterPart)} from starters (0.7 × ${f1(t.starterPpg)} ppg) + ${f1(t.benchPart)} from bench (0.3 × ${f1(t.benchStrength)})`}
        >
          <span className="muted">{t.powerRank}</span>
          <span className={`lg-name${t.mine ? " strong" : ""}`}>{t.name}</span>
          <span className="lg-bar" aria-hidden>
            <span className="seg starter" style={{ width: `${(Math.max(0, t.starterPart - base) / span) * 100}%` }} />
            {t.benchPart > 0 && <span className="seg bench" style={{ width: `${(t.benchPart / span) * 100}%` }} />}
          </span>
          <span className="num strong">{f1(t.powerScore)}</span>
        </div>
      ))}
    </div>
  );
}

function StandingsTable({ teams }: { teams: LeagueTeamRow[] }) {
  const rows = [...teams].sort((a, b) => (a.standingsRank ?? 99) - (b.standingsRank ?? 99) || a.powerRank - b.powerRank);
  const H = ({ label, tip, cls = "" }: { label: string; tip: string; cls?: string }) => (
    <th className={`num ${cls}`.trim()}>
      <span className="th-why">
        {label}
        <Why text={tip} />
      </span>
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
            <H label="Pwr" tip={TIPS.pwr} />
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
              <td className="num">{t.powerRank}</td>
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
      value: `${signed(c.powerGap)} (starters ${signed(c.starterPartGap)}, bench ${signed(c.benchPartGap)})`,
      tone: tone(c.powerGap),
      title: TIPS.gap,
    },
    { label: "Starter ppg gap", value: `${signed(c.starterGap)} pts/wk`, tone: tone(c.starterGap), title: TIPS.starter },
    { label: "Bench strength gap", value: signed(c.benchGap), tone: tone(c.benchGap), title: TIPS.bench },
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

