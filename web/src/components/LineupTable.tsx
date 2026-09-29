import type { LineupSlot } from "../../../server/model/types";
import type { VP } from "../api";
import { f1 } from "../lib/format";
import { Why } from "./common";
import { PlayerChip } from "./PlayerChip";

export function LineupTable({ lineup }: { lineup: LineupSlot[] }) {
  return (
    <div className="table-wrap">
      <table className="table lineup">
        <thead>
          <tr>
            <th>Slot</th>
            <th>Player</th>
            <th className="num">PPG</th>
            <th className="num">Value</th>
            <th aria-label="Why" />
          </tr>
        </thead>
        <tbody>
          {lineup.map((s, i) => {
            const p = s.player as VP | null;
            return (
              <tr key={i}>
                <td>
                  <span className="slot">{s.slot}</span>
                </td>
                <td>
                  <PlayerChip player={p} showValue={false} />
                </td>
                <td className="num">{p ? <PpgCell player={p} /> : "–"}</td>
                <td className="num">{p ? f1(p.value) : "–"}</td>
                <td className="why-cell">{p && <Why text={p.why} />}</td>
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

export function BenchList({ bench }: { bench: VP[] }) {
  if (!bench.length) return <p className="muted">No bench players.</p>;
  return (
    <ul className="bench-list">
      {bench.map((p) => (
        <li key={p.id}>
          <PlayerChip player={p} showValue={false} />
          <span className="bench-nums">
            <span className="muted small">ppg</span> {f1(p.ppg)} <span className="muted small">val</span> {f1(p.value)}
          </span>
          <Why text={p.why} />
        </li>
      ))}
    </ul>
  );
}
