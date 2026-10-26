import type { LineupSlot } from "../../../server/model/types";
import type { VP } from "../api";
import { f1 } from "../lib/format";
import { ColumnHelp, HelpTip } from "./HelpTip";
import { PlayerChip } from "./PlayerChip";

/** One table for the starting lineup and the bench (slot column BN / IR): every roster row looks the same. */
export function LineupTable({ lineup, bench = [], irIds = [] }: { lineup: LineupSlot[]; bench?: VP[]; irIds?: string[] }) {
  const ir = new Set(irIds);
  const rows: LineupSlot[] = [...lineup, ...bench.map((p): LineupSlot => ({ slot: ir.has(p.id) ? "IR" : "BN", player: p }))];
  return (
    <div className="table-wrap">
      <table className="table lineup">
        <thead>
          <tr>
            <th>Slot</th>
            <th>Player</th>
            <th className="num">
              <ColumnHelp tip="Projected points per game for the rest of the season in your scoring (injury-adjusted when he is hurt).">PPG</ColumnHelp>
            </th>
            <th className="num">
              <ColumnHelp tip="Our 0–100 rest-of-season trade value: points above replacement × games left, blended with the expert consensus.">Value</ColumnHelp>
            </th>
            <th aria-label="Why" />
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => {
            const p = s.player as VP | null;
            const benchStart = i === lineup.length && bench.length > 0;
            return (
              <tr key={i} className={`${s.slot === "BN" || s.slot === "IR" ? "bench-row" : ""}${benchStart ? " bench-start" : ""}`.trim() || undefined}>
                <td>
                  <span className="slot">{s.slot}</span>
                </td>
                <td>
                  <PlayerChip player={p} showValue={false} />
                  {p && s.riskFactor != null && (
                    <span
                      className="tag small-tag warn-tag"
                      title={`${p.injury?.status ?? "Injured"}: counted at ×${s.riskFactor} (${f1(p.ppg * s.riskFactor)} ppg) when picking this week's lineup. Check his status before lock.`}
                    >
                      ×{s.riskFactor} · check status
                    </span>
                  )}
                </td>
                <td className="num">{p ? <PpgCell player={p} /> : "—"}</td>
                <td className="num">{p ? f1(p.value) : "—"}</td>
                <td className="why-cell">{p && <HelpTip items={p.whyItems} text={p.whyItems?.length ? undefined : p.why} label={`How ${p.name} is valued`} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Lineup ppg: the injury-adjusted rate (effPpg) when it differs from the healthy ppg. */
function PpgCell({ player }: { player: VP }) {
  const eff = player.effPpg;
  if (eff == null || !Number.isFinite(eff) || f1(eff) === f1(player.ppg)) return <>{f1(player.ppg)}</>;
  return (
    <span title={`Injury-adjusted: ${f1(eff)} ppg over the remaining weeks; ${f1(player.ppg)} ppg when healthy.`}>
      {f1(eff)} <span className="muted small eff-hint">({f1(player.ppg)} healthy)</span>
    </span>
  );
}
