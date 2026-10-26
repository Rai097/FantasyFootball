import { useState } from "react";
import { api, type Active, type Analysis, type BreakoutTargetRow } from "../api";
import { Empty, ErrorBox, Loading, PosBadge } from "../components/common";
import { DetailList, Disclosure, ExpandableList, ExpandableRow } from "../components/ExpandableRow";
import { ColumnHelp, HelpTip } from "../components/HelpTip";
import { InjuryDot } from "../components/PlayerChip";
import { f1 } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { PosFilter } from "./WaiversTab";

const POSITIONS = ["RB", "WR", "TE"];

const TIPS = {
  score: "Breakout score, 0–100: snap trend, expected-points trend and level, usage vs output, and an opening ahead of him (tap How it's scored).",
  role: "His spot on the team's depth chart (or by snap share when snaps overrule the chart).",
  owner: "Who rosters him now: a team in your league, or FA = free agent.",
  rising: "Rising starters: 7+ expected pts/g over the last 2 weeks (TE 4.5) or 50%+ snaps. The role is already here.",
  stash: "Deep stashes: a smaller role today, but trending up or a door is opening ahead of him.",
  snaps: "Share of his team's offensive snaps each week.",
  exp: "Expected fantasy points per game from his opportunities (targets, carries, air yards), your scoring.",
  act: "Actual fantasy points per game, your scoring.",
};

/** Breakout Targets: role rising before fantasy points (FA or on other rosters). One collapsed row each. */
export function TargetsTab({ active }: { analysis: Analysis; active: Active & { team: string } }) {
  const [pos, setPos] = useState("");
  const [cheapOnly, setCheapOnly] = useState(false);
  const res = useAsync(() => api.breakouts(active, pos || "all"), [active.provider, active.id, active.team, pos]);
  // Cheap filter is client-side on components.cheap (market < 15, or our value < 12 without a market).
  const shown = (res.data?.targets ?? []).filter((t) => !cheapOnly || t.components.cheap);
  const rising = shown.filter((t) => t.tier === "rising");
  const stash = shown.filter((t) => t.tier !== "rising");

  return (
    <div className="stack">
      <section className="card stack-sm">
        <div className="row between wrap gap">
          <h2>Breakout targets</h2>
          <div className="row gap wrap">
            <label className="row gap small cheap-toggle">
              <input type="checkbox" checked={cheapOnly} onChange={(e) => setCheapOnly(e.target.checked)} />
              Cheap only
            </label>
            <PosFilter value={pos} onChange={setPos} options={POSITIONS} />
          </div>
        </div>
        {(res.data?.how.length ?? 0) > 0 && (
          <Disclosure title="How it's scored">
            <DetailList items={res.data!.how} />
          </Disclosure>
        )}
      </section>

      {res.error ? (
        <ErrorBox error={res.error} onRetry={res.reload} />
      ) : !res.data ? (
        <Loading label="Scanning depth charts and snap trends…" />
      ) : shown.length === 0 ? (
        <Empty>No breakout targets{pos ? ` at ${pos}` : ""}{cheapOnly ? " under the cheap filter" : ""} right now.</Empty>
      ) : (
        <>
          <TierSection title="Rising starters" tip={TIPS.rising} list={rising} />
          <TierSection title="Deep stashes" tip={TIPS.stash} list={stash} />
        </>
      )}
    </div>
  );
}

const HEADER = (
  <>
    <span className="num">#</span>
    <span>Player</span>
    <span className="num">
      <ColumnHelp tip={TIPS.score}>Score</ColumnHelp>
    </span>
    <span>
      <ColumnHelp tip={TIPS.owner}>Owner</ColumnHelp>
    </span>
    <span>
      <ColumnHelp tip={TIPS.role}>Role</ColumnHelp>
    </span>
  </>
);

function TierSection({ title, tip, list }: { title: string; tip: string; list: BreakoutTargetRow[] }) {
  if (!list.length) return null;
  return (
    <section className="card flush">
      <h3 className="card-title tier-title">
        {title} <span className="muted">({list.length})</span> <HelpTip text={tip} />
      </h3>
      <ExpandableList className="target-list" label={title} header={HEADER}>
        {list.map((t, i) => (
          <TargetRow key={t.player.id} t={t} rank={i + 1} />
        ))}
      </ExpandableList>
    </section>
  );
}

function TargetRow({ t, rank }: { t: BreakoutTargetRow; rank: number }) {
  const ptsMax = Math.max(10, ...t.expPpg, ...t.actPpg);
  const owner = t.where.type === "fa" ? "FA" : t.where.teamName;
  const head = (
    <>
      <span className="num muted t-rank">#{rank}</span>
      <span className="t-player">
        <PosBadge pos={t.player.pos} />
        <span className="strong t-name">{t.player.name}</span>
        <span className="muted small">{t.player.team}</span>
        <InjuryDot player={t.player} />
      </span>
      <span className="num strong t-score">{f1(t.score)}</span>
      <span className={`t-owner small${t.where.type === "fa" ? " fa" : ""}`}>{owner}</span>
      <span className="t-role small">{t.depthLabel ?? "–"}</span>
    </>
  );
  return (
    <ExpandableRow className="target-row" head={head} label={t.player.name}>
      <div className="t-summary">{t.summary}</div>
      <div className="strips">
        <Strip label="Snaps %" tip={TIPS.snaps} weeks={t.weeks} values={t.snaps.map((x) => x * 100)} max={100} kind="snaps" fmt={(x) => `${Math.round(x)}%`} />
        <Strip label="Exp pts" tip={TIPS.exp} weeks={t.weeks} values={t.expPpg} max={ptsMax} kind="exp" fmt={f1} />
        <Strip label="Act pts" tip={TIPS.act} weeks={t.weeks} values={t.actPpg} max={ptsMax} kind="act" fmt={f1} />
      </div>
      {t.tags.length > 0 && (
        <div className="tags">
          {t.tags.map((g) => (
            <span key={g} className={`tag${/hurt|slipping|promoted|left early/.test(g) ? " path-tag" : ""}`}>
              {g}
            </span>
          ))}
        </div>
      )}
      <DetailList items={t.details} />
    </ExpandableRow>
  );
}

function Strip({ label, tip, weeks, values, max, kind, fmt }: { label: string; tip: string; weeks: number[]; values: number[]; max: number; kind: string; fmt: (x: number) => string }) {
  return (
    <div className="strip">
      <span className="strip-label muted">
        <ColumnHelp tip={tip}>{label}</ColumnHelp>
      </span>
      <div className="strip-bars">
        {weeks.map((w, i) => {
          const v = values[i] ?? 0;
          return (
            <div key={w} className="strip-col" title={`Week ${w}: ${fmt(v)}`}>
              <div className="strip-track">
                <div className={`strip-bar ${kind}`} style={{ height: `${Math.max(2, Math.min(100, (v / max) * 100))}%` }} />
              </div>
              <span className="strip-val">{fmt(v)}</span>
              <span className="strip-wk muted">W{w}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
