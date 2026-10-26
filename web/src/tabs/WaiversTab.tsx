import { useState } from "react";
import { api, type Active, type Analysis, type WaiverRow } from "../api";
import { Empty, ErrorBox, Loading, PosBadge } from "../components/common";
import { DetailList, Disclosure, ExpandableList, ExpandableRow } from "../components/ExpandableRow";
import { InjuryDot } from "../components/PlayerChip";
import { deltaClass, f1, signed } from "../lib/format";
import { useAsync } from "../lib/useAsync";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
type Avail = "all" | "fa" | "waivers";

const TIPS = {
  ppg: "Projected fantasy points per game for the rest of the season, in your league's scoring.",
  value: "Trade value on a 0–100 scale; 0 means no better than a typical free agent.",
  gain: "How many points per game your best starting lineup gains if you add him (and drop the player shown in details).",
  call: "What to do: claim, optional, stash, wait or pass. Tap the row for the reasons.",
};

export function WaiversTab({ analysis, active }: { analysis: Analysis; active: Active & { team: string } }) {
  const [pos, setPos] = useState("");
  const [avail, setAvail] = useState<Avail>("all");
  const res = useAsync(() => api.waivers(active), [active.provider, active.id, active.team]);

  if (res.error) return <ErrorBox error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading label="Ranking free agents…" />;
  const { freeAgents, myPriority, numTeams, advice, rules, faStatusKnown } = res.data;
  const byPos = freeAgents.filter((p) => !pos || p.pos === pos);
  const counts = { all: byPos.length, fa: byPos.filter((p) => !p.onWaivers).length, waivers: byPos.filter((p) => p.onWaivers).length };
  const rows = byPos.filter((p) => avail === "all" || !faStatusKnown || (avail === "fa" ? !p.onWaivers : p.onWaivers));
  const { usesFaab, faabBudget } = analysis.league.settings;
  const faabLeft = analysis.league.teams.find((t) => t.id === active.team)?.faabRemaining;

  return (
    <div className="stack">
      <section className="card waiver-head">
        <div className="row gap wrap">
          {myPriority != null ? (
            <span className="pill big" title="Your place in the rolling waiver order; a successful claim moves you to last.">
              Waiver priority <b>#{myPriority}</b> of {numTeams}
            </span>
          ) : (
            <span className="pill big muted" title="Not captured yet: re-import the league with the latest bookmarklet to read the waiver order.">
              Waiver priority unknown
            </span>
          )}
          {usesFaab && (
            <span className="pill big" title="Free-agent budget you have left to bid with this season.">
              FAAB <b>{faabLeft != null ? `$${faabLeft}` : "—"}</b>
              {faabBudget != null ? ` of $${faabBudget}` : ""} left
            </span>
          )}
        </div>
        <p className="advice">{advice}</p>
        {!faStatusKnown && (
          <p className="notice warn small">Free agent or on waivers: status unknown. Re-import your league to see free agents.</p>
        )}
        <div className="row gap wrap">
          {faStatusKnown && (
            <div className="seg" role="group" aria-label="Available now">
              {(
                [
                  ["all", "All"],
                  ["fa", "Free agents"],
                  ["waivers", "On waivers"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={`seg-btn${avail === k ? " active" : ""}`}
                  onClick={() => setAvail(k)}
                  aria-pressed={avail === k}
                  title={k === "fa" ? "Free agents: add any time, no waiver priority used." : k === "waivers" ? "On waivers: needs a claim, which uses your priority." : undefined}
                >
                  {label} <span className="seg-count">{counts[k]}</span>
                </button>
              ))}
            </div>
          )}
          <PosFilter value={pos} onChange={setPos} options={POSITIONS} />
        </div>
        <Disclosure title="How calls work">
          <DetailList items={rules} />
        </Disclosure>
      </section>

      {rows.length === 0 ? (
        <Empty>
          No {avail === "fa" ? "free agents" : avail === "waivers" ? "players on waivers" : "available players"}
          {pos ? ` at ${pos}` : ""}.
        </Empty>
      ) : (
        <div className="card flush">
          <ExpandableList
            label="Available players"
            className="waiver-list"
            header={
              <>
                <span>Player</span>
                <span>Summary</span>
                <span className="num" title={TIPS.ppg}>PPG</span>
                <span className="num" title={TIPS.value}>Value</span>
                <span className="num" title={TIPS.gain}>Gain</span>
                <span title={TIPS.call}>Call</span>
              </>
            }
          >
            {rows.map((p) => (
              <WaiverRow key={p.id} p={p} />
            ))}
          </ExpandableList>
        </div>
      )}
    </div>
  );
}

function AvailBadge({ p }: { p: WaiverRow }) {
  if (p.availability === "fa")
    return (
      <span className="tag small-tag avail-fa" title="Free agent: add any time, no waiver priority used.">
        FA
      </span>
    );
  if (p.availability === "waivers")
    return (
      <span className="tag small-tag avail-w" title="On waivers: needs a claim, which uses your priority.">
        W
      </span>
    );
  return (
    <span className="tag small-tag" title="Status unknown: re-import your league to see free agents vs waivers.">
      ?
    </span>
  );
}

function WaiverRow({ p }: { p: WaiverRow }) {
  return (
    <ExpandableRow
      className="waiver-row"
      label={p.name}
      head={
        <>
          <span className="w-player">
            <PosBadge pos={p.pos} />
            <span className="strong w-name">{p.name}</span>
            <span className="muted small">{p.team}</span>
            <InjuryDot player={p} />
            <AvailBadge p={p} />
          </span>
          <span className="w-summary">{p.summary}</span>
          <span className="num w-stat" title={TIPS.ppg}>
            {f1(p.ppg)}
          </span>
          <span className="num w-stat" title={TIPS.value}>
            {f1(p.value)}
          </span>
          <span className={`num w-stat delta ${deltaClass(p.gain)}`} title={TIPS.gain}>
            {signed(p.gain)}
          </span>
          <span className="w-call" title={TIPS.call}>
            <span className={`rec rec-${p.recommendation}`}>{p.recommendation}</span>
          </span>
        </>
      }
    >
      <div className="stat-tiles" aria-label="Numbers">
        <span className="stat-tile" title={TIPS.ppg}>
          <span className="stat-label">PPG</span>
          <b>{f1(p.ppg)}</b>
        </span>
        <span className="stat-tile" title={TIPS.value}>
          <span className="stat-label">Value</span>
          <b>{f1(p.value)}</b>
        </span>
        <span className="stat-tile" title={TIPS.gain}>
          <span className="stat-label">Gain</span>
          <b className={`delta ${deltaClass(p.gain)}`}>{signed(p.gain)}</b>
        </span>
        {p.percentOwned != null && (
          <span className="stat-tile" title="Share of Yahoo leagues where he is on a roster.">
            <span className="stat-label">Rostered</span>
            <b>{f1(p.percentOwned)}%</b>
          </span>
        )}
      </div>
      <DetailList items={p.details} />
    </ExpandableRow>
  );
}

export function PosFilter({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div className="seg" role="group" aria-label="Position filter">
      {["", ...options].map((o) => (
        <button key={o || "all"} className={`seg-btn${value === o ? " active" : ""}`} onClick={() => onChange(o)} aria-pressed={value === o}>
          {o || "All"}
        </button>
      ))}
    </div>
  );
}
