import { useState } from "react";
import { api, type Active, type Analysis, type TradeMode } from "../api";
import type { Trade } from "../../../server/model/types";
import { Empty, ErrorBox, Loading } from "../components/common";
import { DetailList, Disclosure, ExpandableList, ExpandableRow } from "../components/ExpandableRow";
import { ColumnHelp, HelpTip } from "../components/HelpTip";
import { TradeBuilder, type BuilderPrefill } from "../components/TradeBuilder";
import { TradeTable } from "../components/TradeTable";
import { useAsync } from "../lib/useAsync";
import { f1 } from "../lib/format";

const POSITIONS = ["QB", "RB", "WR", "TE"];

const MODES: { id: TradeMode; label: string; blurb: string }[] = [
  { id: "now", label: "Win now", blurb: "This week's starting lineup, with a little credit for bench depth." },
  { id: "balanced", label: "Balanced", blurb: "This week, the rest of the season (byes and injuries included), the playoffs and bench depth." },
  { id: "playoffs", label: "Playoffs", blurb: "Your lineup in the playoff weeks first, then the rest of the season and depth." },
];

type View = "suggestions" | "build" | "partners";
const VIEWS: { id: View; label: string }[] = [
  { id: "suggestions", label: "Suggestions" },
  { id: "build", label: "Build a trade" },
  { id: "partners", label: "Partners" },
];

const MODE_KEY = "ftd.tradeMode";
function loadMode(): TradeMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === "now" || m === "playoffs" || m === "balanced" ? m : "balanced";
  } catch {
    return "balanced";
  }
}

export function TradesTab({ analysis, active }: { analysis: Analysis; active: Active & { team: string } }) {
  const [mode, setModeState] = useState<TradeMode>(loadMode);
  const [view, setView] = useState<View>("suggestions");
  const [prefill, setPrefill] = useState<BuilderPrefill>();
  const [partner, setPartner] = useState("");
  const [wantPos, setWantPos] = useState("");
  const [size, setSize] = useState(2);
  const [shown, setShown] = useState(10);
  const others = analysis.teams.filter((t) => t.team.id !== active.team);
  const names = new Map(analysis.teams.map((t) => [t.team.id, t.team.name]));
  const me = analysis.teams.find((t) => t.team.id === active.team);
  const nameOf = (t: Trade) => names.get(t.them.teamId) ?? t.them.teamId;
  const setMode = (m: TradeMode) => {
    setModeState(m);
    setShown(10);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* private mode: not remembered */
    }
  };
  const openInBuilder = (t: Trade) => {
    setPrefill({ nonce: Date.now(), partner: t.them.teamId, give: t.me.gives.map((p) => p.id), get: t.them.gives.map((p) => p.id) });
    setView("build");
  };

  const res = useAsync(
    () => api.trades2(active, { mode, partner: partner || undefined, wantPos: wantPos || undefined, maxGive: size, maxGet: size }),
    [active.provider, active.id, active.team, mode, partner, wantPos, size],
  );
  const bench = useAsync(() => api.benchUpgrades(active, mode), [active.provider, active.id, active.team, mode]);

  const { currentWeek, tradeDeadlineWeek } = analysis.league.settings;
  const pastDeadline = tradeDeadlineWeek != null && currentWeek > tradeDeadlineWeek;
  const data = res.data;
  const blurb = MODES.find((m) => m.id === mode)!.blurb;

  const tradeList = (list: Trade[], label: string) => <TradeTable trades={list} nameOf={nameOf} label={label} onOpenBuilder={openInBuilder} />;

  return (
    <div className="trades-page stack">
      {pastDeadline && <div className="notice warn one-line">The trade deadline (week {tradeDeadlineWeek}) has passed: no trades to suggest.</div>}
      <div className="trades-controls">
        <div className="row gap">
          <div className="seg" role="radiogroup" aria-label="What to optimise for">
            {MODES.map((m) => (
              <button key={m.id} role="radio" aria-checked={mode === m.id} className={`seg-btn ${mode === m.id ? "active" : ""}`} onClick={() => setMode(m.id)} title={m.blurb}>
                {m.label}
              </button>
            ))}
          </div>
          <HelpTip text={blurb} label="What this mode optimises" />
        </div>
        <div className="seg view-seg" role="tablist" aria-label="Trade Finder view">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={view === v.id} className={`seg-btn ${view === v.id ? "active" : ""}`} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {view === "suggestions" && (
        <>
          <section className="card stack-sm">
            <div className="filters">
              <label className="field">
                <span>Partner</span>
                <select value={partner} onChange={(e) => (setPartner(e.target.value), setShown(10))}>
                  <option value="">All teams</option>
                  {others.map((t) => (
                    <option key={t.team.id} value={t.team.id}>
                      {t.team.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>I want a</span>
                <select value={wantPos} onChange={(e) => (setWantPos(e.target.value), setShown(10))}>
                  <option value="">Any position</option>
                  {POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                      {me?.needs.includes(p) ? " (need)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Package size</span>
                <select value={size} onChange={(e) => (setSize(Number(e.target.value)), setShown(10))}>
                  <option value={1}>1-for-1 only</option>
                  <option value={2}>Up to 2 (3-for-1 to struggling teams)</option>
                </select>
              </label>
            </div>
          </section>

          {res.loading && <Loading label="Scoring every package against every team…" />}
          {res.error && <ErrorBox error={res.error} onRetry={res.reload} />}
          {!res.loading && data && (
            <>
              {data.valueSource === "model" && (
                <div className="notice warn one-line small">
                  Market values are unavailable: using our own values.{" "}
                  <HelpTip text="FantasyCalc did not answer, so the market-value part of acceptance (20%) uses our values and 'market undervalues / overvalues' tags are not shown." />
                </div>
              )}
              <div className={`notice finder-summary${data.trades.length === 0 ? " warn" : ""}`}>
                <div className="one-line">{data.summary}</div>
                {(data.summaryDetails?.length ?? 0) > 0 && (
                  <Disclosure title="Why">
                    <DetailList items={data.summaryDetails!} />
                  </Disclosure>
                )}
              </div>
              {data.trades.length > 0 && (
                <section className="card flush">
                  <div className="row between card-head">
                    <h2 className="card-title">
                      Trades <span className="muted">({data.trades.length})</span>
                    </h2>
                    <Disclosure title="How they're ranked">
                      <DetailList items={rankingFor(mode)} />
                    </Disclosure>
                  </div>
                  {tradeList(data.trades.slice(0, shown), "Suggested trades")}
                  {shown < data.trades.length && (
                    <div className="table-more">
                      <button className="btn" onClick={() => setShown((s) => s + 10)}>
                        Show more ({data.trades.length - shown} left)
                      </button>
                    </div>
                  )}
                </section>
              )}
              <Fold title="Smaller edges" count={data.smallerEdges.length} hint="smaller gains, still fair to them">
                {tradeList(data.smallerEdges, "Smaller edges")}
              </Fold>
              <Fold title="Near misses" count={data.nearMisses.length} hint="good for you, but they'd likely refuse">
                {tradeList(data.nearMisses, "Near misses")}
              </Fold>
            </>
          )}

          {bench.loading && <Loading label="Looking for bench upgrades…" />}
          {bench.error && <ErrorBox error={bench.error} onRetry={bench.reload} />}
          {!bench.loading && bench.data && bench.data.length === 0 && <Empty>No bench swap raises your season lineup at a price they would take.</Empty>}
          {!bench.loading && bench.data && bench.data.length > 0 && (
            <Fold title="Bench upgrades" count={bench.data.length} hint="swap a bench player up" tip={BENCH_TIP}>
              {tradeList(bench.data, "Bench upgrades")}
            </Fold>
          )}
        </>
      )}

      <div hidden={view !== "build"}>
        <TradeBuilder analysis={analysis} active={active} mode={mode} prefill={prefill} />
      </div>

      {view === "partners" && (
        <>
          {res.loading && <Loading label="Finding best-fit partners…" />}
          {res.error && <ErrorBox error={res.error} onRetry={res.reload} />}
          {!res.loading && data && (data.partners?.length ?? 0) === 0 && <Empty>No partner stands out right now.</Empty>}
          {!res.loading && data && (data.partners?.length ?? 0) > 0 && (
            <section className="card flush">
              <h2 className="card-title">
                Best-fit partners <HelpTip text="Teams whose needs match your spare depth (and the reverse): where a plausible ask starts." />
              </h2>
              <ExpandableList className="fit-list" label="Best-fit partners" header={PARTNER_HEADER}>
                {data.partners!.map((p) => {
                  const pick = (label: string) => p.details.find((d) => d.label === label)?.value ?? "—";
                  const team = names.get(p.teamId) ?? p.teamId;
                  return (
                    <ExpandableRow
                      key={p.teamId}
                      className="partner-row"
                      label={team}
                      head={
                        <>
                          <span className="strong p-name">{team}</span>
                          <span className="p-need" data-label="Their need">
                            {pick("Their weakest spot")}
                          </span>
                          <span className="p-offer" data-label="You can offer">
                            {pick("Your spare depth")}
                          </span>
                          <span className="num">{f1(p.complementarity)}</span>
                        </>
                      }
                    >
                      <DetailList items={p.details} />
                    </ExpandableRow>
                  );
                })}
              </ExpandableList>
            </section>
          )}
        </>
      )}
    </div>
  );
}

const PARTNER_HEADER = (
  <>
    <span>Team</span>
    <span>Their need</span>
    <span>You can offer</span>
    <span className="num">
      <ColumnHelp tip="Fit score: their weak groups × your spare depth, plus the reverse (higher = more to trade about).">Fit</ColumnHelp>
    </span>
  </>
);

const BENCH_TIP =
  "1-for-1 swaps of a bench player (or your weakest starter) that add 0.8+ pts/week to your rest-of-season lineup; both players worth 3+, the one you get a real asset.";

/** "How they're ranked": the listing bar follows the mode (server/model/tradesV3.ts listsInMode). */
const MODE_BAR: Record<TradeMode, { label: string; value: string }[]> = {
  playoffs: [{ label: "Your playoff strength", value: "+1.0 pts/week or more (weeks 15–17 lineup + 0.25 × bench cover)" }],
  balanced: [
    { label: "Your team score", value: "+1.0 or more (this week, rest of season and playoffs)" },
    { label: "Playoff strength", value: "Not down more than 0.5 pts/week" },
  ],
  now: [
    { label: "Your team score", value: "+1.0 or more (your lineup's average points per game from now on, missed games counted, plus a little bench depth)" },
    { label: "Playoff strength", value: "Not down more than 1.0 pts/week" },
  ],
};
const rankingFor = (mode: TradeMode) => [
  ...MODE_BAR[mode],
  { label: "Their side", value: "Not a loss in what Yahoo shows them" },
  { label: "Their view", value: "Yahoo projections + recent games (estimate until captured)" },
  { label: "Acceptance", value: "40% or more: 80% their lineup view, 20% market value" },
  { label: "Order", value: `(your ${mode === "playoffs" ? "playoff strength" : "team score"} gain + perception-gap bonus) × acceptance` },
  { label: "Variety", value: "At most 2 per partner and 2 per player you give" },
];

function Fold({ title, count, hint, tip, children }: { title: string; count: number; hint: string; tip?: string; children: React.ReactNode }) {
  if (!count) return null;
  return (
    <details className="fold">
      <summary>
        {title} ({count}) <span className="muted small">{hint}</span> {tip && <HelpTip text={tip} />}
      </summary>
      <div className="fold-body flush-body">{children}</div>
    </details>
  );
}
