// Matchup tab (docs/DESIGN.md "Matchups and results log"): this week's two lineups side by side with OUR projection
// next to Yahoo's, the other pairings, and a track record of how our team projections held up. Import leagues only.
import { useState } from "react";
import { api, type Active } from "../api";
import type { MatchupCell, MatchupResponse, MatchupSideView, RecordWeek } from "../../../server/model/matchup";
import { ColumnHelp, HelpTip } from "../components/HelpTip";
import { DetailList, Disclosure, ExpandableList, ExpandableRow } from "../components/ExpandableRow";
import { Empty, ErrorBox, Loading, PosBadge } from "../components/common";
import { f1, stamp } from "../lib/format";
import { callMark, chipTitle, incompleteLabel, notRecorded, orientGame, pairOrDash, recordPair, winPcts } from "../lib/matchupView";
import { useAsync } from "../lib/useAsync";

const TIP = {
  ours: "Our projection: the sum of the starters' projections this week. Once a player's game has started his number is the one captured before kickoff.",
  yahoo: "Yahoo's own projection, taken before the week's first kickoff so it stays comparable with the final score.",
  score: "Yahoo's points so far (final once the week is over); stat corrections can still move it until Thursday.",
  yahooPage: "Yahoo's own projected total from its matchup page; the track record uses each starter's pre-kickoff Yahoo projection instead.",
  pts: "Yahoo's fantasy points for this player; a dash means he has not played yet.",
  win: "Chance our projections give each team to win: the projected margin against a typical weekly spread of about 35 points. A pre-game estimate, not updated live.",
  incomplete: "These starters have no projection of ours, so the total is left blank instead of counting them as 0.",
  calls: "Games where both our projection and Yahoo's picked a winner and the final score is in: how often each picked the winner.",
  mae: "Average miss: how many points off the team total was from the final score, over the same team-weeks for both sources.",
  bias: "Average final minus projected: positive means the projection ran low, negative means it ran high.",
  notRecorded: "We did not keep our projections before the first capture, so only Yahoo's numbers exist for this week.",
  call: "A check means the projected winner won the game.",
  source: "Where the starters come from: Yahoo's matchup page, the latest import, or the projection log's captures.",
};

const SOURCE_LABEL = { page: "Lineup from Yahoo's matchup page", import: "Lineup as of the last import", log: "Lineup as of the last capture" } as const;
const STATUS_LABEL = { final: "Final", live: "In progress", pre: "Not started", unknown: "Status unknown" } as const;

export function MatchupTab({ active }: { active: Active & { team: string } }) {
  const isImport = active.provider === "import";
  const [week, setWeek] = useState<number | undefined>();
  const res = useAsync(() => (isImport ? api.matchup(active, week) : null), [active.provider, active.id, active.team, week]);
  if (!isImport) return <Empty>Matchups need an imported league.</Empty>;
  if (res.error?.status === 404) return <Empty>Matchups need an imported league.</Empty>;
  if (res.error) return <ErrorBox error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading label="Loading matchup…" />;
  const m = res.data;
  return (
    <div className={`stack mu-tab${res.loading ? " mu-busy" : ""}`}>
      <WeekPicker m={m} onPick={setWeek} />
      {m.mine ? (
        <>
          <HeaderCard m={m} sides={m.mine.sides} source={m.mine.lineupSource} />
          <LineupCard mine={m.mine} />
        </>
      ) : (
        <Empty>No lineups recorded for week {m.week} yet. Import before kickoff to capture them.</Empty>
      )}
      {m.others.length > 0 && <OthersCard m={m} />}
      <RecordCard m={m} myTeamId={m.mine?.sides[0].teamId ?? active.team} />
    </div>
  );
}

function WeekPicker({ m, onPick }: { m: MatchupResponse; onPick: (w: number) => void }) {
  return (
    <div className="mu-weekbar row gap wrap">
      <label className="row gap">
        <span className="strong">Week</span>
        <select value={m.week} onChange={(e) => onPick(Number(e.target.value))} aria-label="Week">
          {m.weeks.map((w) => (
            <option key={w} value={w}>
              {w}
              {w === m.currentWeek ? " (current)" : ""}
            </option>
          ))}
        </select>
      </label>
      <span className="pill">{STATUS_LABEL[m.status]}</span>
    </div>
  );
}

function HeaderCard({ m, sides, source }: { m: MatchupResponse; sides: [MatchupSideView, MatchupSideView]; source: keyof typeof SOURCE_LABEL }) {
  const [a, b] = sides;
  const wins = winPcts(a.winPct);
  const asOf = m.asOf ? `as of ${stamp(m.asOf)}` : "not captured";
  const inc = (s: MatchupSideView) => incompleteLabel(s.oursIncomplete);
  return (
    <section className="card mu-head">
      <div className="mu-teams">
        <span className="mu-lbl" />
        {[a, b].map((s) => (
          <div key={s.teamId} className="mu-team">
            <span className="strong mu-team-name">{s.name}</span>
            <span className="muted small">{s.record ?? "—"}</span>
          </div>
        ))}
      </div>
      <TotalRow label="Ours" tip={TIP.ours} a={f1(a.ours)} b={f1(b.ours)} notes={[inc(a), inc(b)]} />
      {m.status === "final" ? (
        <TotalRow label="Yahoo (page)" tip={TIP.yahooPage} a={f1(a.yahoo)} b={f1(b.yahoo)} />
      ) : (
        <TotalRow label="Yahoo" tip={TIP.yahoo} a={f1(a.yahoo)} b={f1(b.yahoo)} />
      )}
      <TotalRow label="Score" sub={asOf} tip={TIP.score} a={f1(a.points)} b={f1(b.points)} />
      <div className="mu-chips row gap wrap">
        {wins ? (
          <span className="pill big mu-win">
            {a.name} {wins[0]} · {b.name} {wins[1]} <span className="muted">pre-game estimate</span>
            <HelpTip text={TIP.win} label="About the win chance" />
          </span>
        ) : (
          <span className="pill muted">
            Win chance —<HelpTip text="Needs a complete projection of ours for both teams." label="Why no win chance" />
          </span>
        )}
        <span className="pill muted">
          {SOURCE_LABEL[source]}
          <HelpTip text={TIP.source} label="About the lineup source" />
        </span>
      </div>
    </section>
  );
}

function TotalRow({ label, sub, tip, a, b, notes }: { label: string; sub?: string; tip: string; a: string; b: string; notes?: (string | null)[] }) {
  return (
    <div className="mu-total">
      <span className="mu-lbl">
        <ColumnHelp tip={tip}>{label}</ColumnHelp>
        {sub && <span className="muted small mu-sub">{sub}</span>}
      </span>
      {[a, b].map((v, i) => (
        <span key={i} className="mu-val">
          <b>{v}</b>
          {notes?.[i] && (
            <span className="mu-incomplete">
              {notes[i]}
              <HelpTip text={TIP.incomplete} label="Why incomplete" />
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- mirrored lineup
type Slot = { slot: string; a: MatchupCell | null; b: MatchupCell | null };

function LineupCard({ mine }: { mine: NonNullable<MatchupResponse["mine"]> }) {
  const [a, b] = mine.sides;
  return (
    <section className="card flush mu-lineup">
      <MirrorHead a={a.name} b={b.name} />
      <div role="list" aria-label="Starting lineups">
        {mine.rows.map((r, i) => (
          <MirrorRow key={`${r.slot}-${i}`} r={r} />
        ))}
      </div>
      {mine.bench.length > 0 && (
        <div className="mu-bench">
          <Disclosure title={`Bench (${mine.bench.length})`}>
            <div role="list" aria-label="Benches">
              {mine.bench.map((r, i) => (
                <MirrorRow key={`${r.slot}-${i}`} r={r} />
              ))}
            </div>
          </Disclosure>
        </div>
      )}
    </section>
  );
}

function MirrorHead({ a, b }: { a: string; b: string }) {
  const cols = (flip: boolean) => {
    const c = [
      <span key="o" className="num">
        <ColumnHelp tip={TIP.ours}>Ours</ColumnHelp>
      </span>,
      <span key="y" className="num mu-ycol">
        <ColumnHelp tip={TIP.yahoo}>Yahoo</ColumnHelp>
      </span>,
      <span key="p" className="num">
        <ColumnHelp tip={TIP.pts}>Pts</ColumnHelp>
      </span>,
    ];
    return flip ? [c[2], c[1], c[0]] : c;
  };
  return (
    <div className="mu-row mu-headrow" aria-hidden>
      <span className="mu-name strong">{a}</span>
      {cols(false)}
      <span />
      {cols(true)}
      <span className="mu-name strong right">{b}</span>
    </div>
  );
}

function MirrorRow({ r }: { r: Slot }) {
  const side = (c: MatchupCell | null, flip: boolean) => {
    const nums = [
      <span key="o" className="num" title={c?.locked ? "Captured before his game started" : undefined}>
        {c ? f1(c.ours) : "—"}
        {c?.locked && <span className="mu-lock" aria-label="locked" />}
      </span>,
      <span key="y" className="num mu-ycol">
        {c ? f1(c.yahoo) : "—"}
      </span>,
      <span key="p" className="num">
        {c ? f1(c.points) : "—"}
      </span>,
    ];
    return { name: <PlayerCell c={c} right={flip} />, nums: flip ? [nums[2], nums[1], nums[0]] : nums };
  };
  const L = side(r.a, false);
  const R = side(r.b, true);
  return (
    <ExpandableRow
      className="mu-xrow"
      label={`${r.slot}: ${r.a?.name ?? "empty"} vs ${r.b?.name ?? "empty"}`}
      head={
        <div className="mu-row">
          {L.name}
          {L.nums}
          <span className="mu-slot">{r.slot}</span>
          {R.nums}
          {R.name}
        </div>
      }
    >
      <div className="mu-detail-pair">
        <CellDetails c={r.a} />
        <CellDetails c={r.b} />
      </div>
    </ExpandableRow>
  );
}

function PlayerCell({ c, right }: { c: MatchupCell | null; right: boolean }) {
  if (!c) return <span className={`mu-name muted${right ? " right" : ""}`}>Empty</span>;
  return (
    <span className={`mu-name${right ? " right" : ""}`}>
      {c.pos && <PosBadge pos={c.pos} />}
      <span className="mu-pname">{c.name}</span>
      {c.status && (
        <span className={`mu-status s-${c.status.toLowerCase()}`} title={chipTitle(c)}>
          {c.status}
        </span>
      )}
    </span>
  );
}

function CellDetails({ c }: { c: MatchupCell | null }) {
  if (!c) return <div className="muted small">Empty slot</div>;
  return (
    <DetailList
      items={[
        { label: "Player", value: [c.name, c.nflTeam].filter(Boolean).join(" · ") },
        { label: "Ours", value: f1(c.ours), title: TIP.ours },
        { label: "Yahoo", value: f1(c.yahoo), title: TIP.yahoo },
        { label: "Points", value: f1(c.points), title: TIP.pts },
        ...(c.ours == null ? [{ label: "Note", value: "No projection of ours", tone: "warn" as const }] : []),
        ...(c.locked ? [{ label: "Game", value: "Started: ours is the pre-kickoff value" }] : []),
        ...(c.status ? [{ label: "Status", value: chipTitle(c) ?? c.status, tone: "warn" as const }] : []),
      ]}
    />
  );
}

// ---------------------------------------------------------------- other matchups
function OthersCard({ m }: { m: MatchupResponse }) {
  return (
    <section className="card mu-others">
      <Disclosure title={`Other matchups (${m.others.length})`}>
        <ExpandableList label="Other matchups" className="mu-list">
          {m.others.map((o, i) => {
            const [a, b] = o.sides;
            return (
              <ExpandableRow
                key={`${a.teamId}-${b.teamId}-${i}`}
                className="mu-orow"
                label={`${a.name} vs ${b.name}`}
                head={
                  <div className="mu-orow-head">
                    <span className="mu-oteams">
                      {a.name} <span className="muted">vs</span> {b.name}
                    </span>
                    <span className="num" title={TIP.ours}>
                      {pairOrDash(a.ours, b.ours)}
                    </span>
                    <span className="num mu-ycol" title={TIP.yahoo}>
                      {pairOrDash(a.yahoo, b.yahoo)}
                    </span>
                    <span className="num" title={TIP.score}>
                      {pairOrDash(a.points, b.points)}
                    </span>
                  </div>
                }
              >
                <DetailList
                  items={[
                    { label: "Ours", value: pairOrDash(a.ours, b.ours), title: TIP.ours },
                    { label: "Yahoo", value: pairOrDash(a.yahoo, b.yahoo), title: TIP.yahoo },
                    { label: "Score", value: pairOrDash(a.points, b.points), title: TIP.score },
                    ...[a, b].flatMap((s) => {
                      const t = incompleteLabel(s.oursIncomplete);
                      return t ? [{ label: s.name, value: t, tone: "warn" as const, title: TIP.incomplete }] : [];
                    }),
                    ...(o.lineupSource ? [{ label: "Lineup", value: SOURCE_LABEL[o.lineupSource], title: TIP.source }] : []),
                  ]}
                />
              </ExpandableRow>
            );
          })}
        </ExpandableList>
      </Disclosure>
    </section>
  );
}

// ---------------------------------------------------------------- track record
function RecordCard({ m, myTeamId }: { m: MatchupResponse; myTeamId: string }) {
  const s = m.record.summary;
  const name = (id: string) => m.teams[id] ?? "—";
  const weeks = m.record.weeks;
  return (
    <section className="card flush mu-record">
      <h2 className="card-title">Track record</h2>
      {weeks.length === 0 ? (
        <p className="muted small mu-pad">Starts once a week with imported lineups is final.</p>
      ) : (
        <>
          <div className="mu-chips row gap wrap mu-pad">
            <span className="pill big" title={TIP.calls}>
              Winner calls: ours {s.games ? `${s.oursCalls}/${s.games}` : "—"} · Yahoo {s.games ? `${s.yahooCalls}/${s.games}` : "—"}
              <HelpTip text={TIP.calls} label="About winner calls" />
            </span>
            <span className="pill big" title={TIP.mae}>
              Avg miss: ours {f1(s.oursMae)} · Yahoo {f1(s.yahooMae)}
              <HelpTip text={TIP.mae} label="About the average miss" />
            </span>
            <span className="pill muted" title={TIP.bias}>
              Bias: ours {f1(s.oursBias)} · Yahoo {f1(s.yahooBias)}
              <HelpTip text={TIP.bias} label="About the bias" />
            </span>
          </div>
          <div className="mu-colhead" aria-hidden="true">
            <span />
            <span className="mu-opp" />
            <span title={TIP.ours}>Ours</span>
            <span className="mu-ycol" title={TIP.yahoo}>Yahoo</span>
            <span title={TIP.score}>Final</span>
            <span />
          </div>
          <ExpandableList label="Weekly results" className="mu-list">
            {weeks.map((w) => (
              <WeekRow key={w.week} w={w} myTeamId={myTeamId} name={name} />
            ))}
          </ExpandableList>
        </>
      )}
    </section>
  );
}

function WeekRow({ w, myTeamId, name }: { w: RecordWeek; myTeamId: string; name: (id: string) => string }) {
  const games = w.games.map((g) => orientGame(g, myTeamId));
  const g = games[0];
  if (!g) return null;
  const opp = g.mine ? `vs ${name(g.teams[1])}` : `${name(g.teams[0])} vs ${name(g.teams[1])}`;
  const nr = notRecorded(g);
  return (
    <ExpandableRow
      className="mu-wrow"
      label={`Week ${w.week}`}
      head={
        <div className="mu-wrow-head">
          <span className="strong">Wk {w.week}</span>
          <span className="mu-opp">{opp}</span>
          <span className="num" title={nr ? TIP.notRecorded : TIP.ours}>
            {nr ? <span className="muted">not recorded</span> : recordPair(g.ours, g.oursMissing)}
          </span>
          <span className="num mu-ycol" title={TIP.yahoo}>
            {recordPair(g.yahoo, g.yahooMissing)}
          </span>
          <span className="num" title={TIP.score}>
            {pairOrDash(g.points[0], g.points[1])}
          </span>
          <span className="mu-calls" title={TIP.call}>
            <span className={`call c-${g.oursCall}`}>{nr ? "—" : callMark(g.oursCall)}</span>
            <span className={`call c-${g.yahooCall}`}>{callMark(g.yahooCall)}</span>
          </span>
        </div>
      }
    >
      {!w.recorded && <p className="muted small">Not recorded: {TIP.notRecorded}</p>}
      {games.map((x, i) => (
        <DetailList
          key={i}
          items={[
            { label: `${name(x.teams[0])} vs ${name(x.teams[1])}`, value: "" },
            { label: "Ours", value: notRecorded(x) ? "not recorded" : recordPair(x.ours, x.oursMissing), title: TIP.ours },
            { label: "Yahoo", value: recordPair(x.yahoo, x.yahooMissing), title: TIP.yahoo },
            { label: "Final", value: pairOrDash(x.points[0], x.points[1]), title: TIP.score },
            { label: "Winner call", value: `ours ${notRecorded(x) ? "—" : callMark(x.oursCall)} · Yahoo ${callMark(x.yahooCall)}`, title: TIP.call },
          ]}
        />
      ))}
    </ExpandableRow>
  );
}
