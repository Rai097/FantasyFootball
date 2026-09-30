import { useState } from "react";
import { api, type Active, type Analysis, type BreakoutTarget } from "../api";
import { Empty, ErrorBox, Loading, Why } from "../components/common";
import { InjuryDot, PlayerChip } from "../components/PlayerChip";
import { f1, signed } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { PosFilter } from "./WaiversTab";

const POSITIONS = ["RB", "WR", "TE"];

/** Breakout Targets: role rising before fantasy points (FA or on other rosters). */
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
      <section className="card">
        <div className="row between wrap">
          <div>
            <h2>Breakout targets</h2>
            <p className="muted small targets-sub">Players whose snaps and expected points are rising before their fantasy points have, with a path to a bigger role.</p>
          </div>
          <div className="row gap wrap">
            <label className="row gap small cheap-toggle">
              <input type="checkbox" checked={cheapOnly} onChange={(e) => setCheapOnly(e.target.checked)} />
              Cheap only (market &lt; 15)
            </label>
            <PosFilter value={pos} onChange={setPos} options={POSITIONS} />
          </div>
        </div>
        {res.data?.notes.map((n) => (
          <p key={n} className="muted small targets-note">
            {n}
          </p>
        ))}
      </section>

      {res.error ? (
        <ErrorBox error={res.error} onRetry={res.reload} />
      ) : !res.data ? (
        <Loading label="Scanning depth charts and snap trends…" />
      ) : shown.length === 0 ? (
        <Empty>No breakout targets{pos ? ` at ${pos}` : ""}{cheapOnly ? " under the cheap filter" : ""} right now.</Empty>
      ) : (
        <>
          <TierSection title="Rising starters" sub="≥ 7 expected pts/g over the last 2 weeks (TE 4.5) or ≥ 50% snaps: the role is already here." list={rising} />
          <TierSection title="Deep stashes" sub="Smaller role today, but trending up or a door is opening ahead of him." list={stash} />
        </>
      )}
    </div>
  );
}

function TierSection({ title, sub, list }: { title: string; sub: string; list: BreakoutTarget[] }) {
  if (!list.length) return null;
  return (
    <section className="stack-sm">
      <div>
        <h3 className="tier-title">
          {title} <span className="muted">({list.length})</span>
        </h3>
        <p className="muted small tier-sub">{sub}</p>
      </div>
      <div className="targets-grid">
        {list.map((t, i) => (
          <TargetCard key={t.player.id} t={t} rank={i + 1} />
        ))}
      </div>
    </section>
  );
}

function componentsText(t: BreakoutTarget): string {
  const c = t.components;
  const p = c.parts;
  const pts = (x: number) => f1(x * 100);
  return [
    `Score ${f1(t.score)} = snap trend ${pts(p.roleTrend)} (${signed(c.roleTrend * 100)} pts, scaled ${f1(c.nRoleTrend)})`,
    `+ exp-pts trend ${pts(p.oppTrend)} (${signed(c.oppTrend)}/g, scaled ${f1(c.nOppTrend)})`,
    `+ exp pts level ${pts(p.oppLevel)} (${f1(c.oppLevel)}/g last 2 wks, scaled ${f1(c.nOppLevel)})`,
    `+ usage gap ${pts(p.gap)} (${signed(c.gap)} exp − act ppg, scaled ${f1(c.nGap)})`,
    `+ situation ${pts(p.situation)} (${c.situation === 1 ? "path open" : c.situation === 0.5 ? "role tag / starter left early" : "none"}).`,
    `Scaled within ${t.player.pos}s; price is not scored.`,
    `Snaps now ${f1(c.roleNow * 100)}%. Production ${t.player.pos}${c.prodRank}${c.ecrPos != null ? ` vs ECR ${t.player.pos}${Math.round(c.ecrPos)}` : ""}${c.age != null ? `, age ${f1(c.age)}` : ""}.`,
  ].join(" ");
}

function TargetCard({ t, rank }: { t: BreakoutTarget; rank: number }) {
  const ptsMax = Math.max(10, ...t.expPpg, ...t.actPpg);
  return (
    <article className="card target-card">
      <div className="row between gap target-top">
        <div className="row gap target-who">
          <span className="target-rank muted">#{rank}</span>
          <PlayerChip player={t.player} compact />
        </div>
        <span className="row gap target-score" title="Breakout score (0–100)">
          <span className="score-num">{f1(t.score)}</span>
          <Why text={componentsText(t)} />
        </span>
      </div>

      <div className="row gap wrap small">
        {t.where.type === "fa" ? <span className="tag fa-tag">Free agent</span> : <span className="tag owner-tag">{t.where.teamName}</span>}
        {t.depthLabel && (
          <span className="tag" title={t.chartSays ? `Depth chart says ${t.chartSays}; snaps say ${t.depthLabel}` : "Depth chart slot"}>
            {t.depthLabel}
            {t.chartSays ? ` (chart ${t.chartSays})` : ""}
          </span>
        )}
        {t.tags.map((g) => (
          <span key={g} className={`tag${/hurt|slipping|promoted|left early/.test(g) ? " path-tag" : ""}`}>
            {g}
          </span>
        ))}
      </div>

      {t.ahead.length > 0 && (
        <div className="ahead small">
          <span className="muted">Ahead: </span>
          {t.ahead.map((a, i) => (
            <span key={a.id} className="ahead-item">
              {a.name}
              {a.status && <InjuryDot player={{ injury: { status: a.status, detail: a.detail, week: 0 } }} />}
              {a.status && <span className="muted"> {a.status}</span>}
              {a.leftEarly && <span className="delta neg"> left early?</span>}
              {!a.leftEarly && Math.abs(a.snapTrend) >= 0.05 && (
                <span className={`delta ${a.snapTrend < 0 ? "neg" : "pos"}`}> {signed(a.snapTrend * 100)} snaps</span>
              )}
              {i < t.ahead.length - 1 && <span className="muted">,</span>}
            </span>
          ))}
        </div>
      )}

      <div className="strips">
        <Strip label="Snaps %" weeks={t.weeks} values={t.snaps.map((x) => x * 100)} max={100} kind="snaps" fmt={(x) => `${Math.round(x)}%`} />
        <Strip label="Exp pts" weeks={t.weeks} values={t.expPpg} max={ptsMax} kind="exp" fmt={f1} />
        <Strip label="Act pts" weeks={t.weeks} values={t.actPpg} max={ptsMax} kind="act" fmt={f1} />
      </div>

      <p className="thesis">{t.thesis}</p>
      <div className="price small">
        <span className="muted">Price</span>
        <span>
          market <b>{t.components.marketValue != null ? f1(t.components.marketValue) : "–"}</b>
        </span>
        <span>
          our value <b>{f1(t.components.value)}</b>
        </span>
        {t.components.cheap && <span className="tag small-tag fa-tag">cheap</span>}
      </div>
      {t.ask && <div className={`ask${t.where.type === "fa" ? " ask-fa" : ""}`}>{t.ask}</div>}
    </article>
  );
}

function Strip({ label, weeks, values, max, kind, fmt }: { label: string; weeks: number[]; values: number[]; max: number; kind: string; fmt: (x: number) => string }) {
  return (
    <div className="strip">
      <span className="strip-label muted">{label}</span>
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
