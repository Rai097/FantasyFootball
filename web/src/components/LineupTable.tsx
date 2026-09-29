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
                <td className="num">{p ? f1(p.ppg) : "–"}</td>
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
