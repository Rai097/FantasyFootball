import type { TeamAnalysis } from "../../../server/model/types";
import { f1 } from "../lib/format";
import { RankBadge } from "./common";

const ORDER = ["QB", "RB", "WR", "TE", "FLEX", "SFLEX", "K", "DEF"];

export function PositionStrength({ me, all }: { me: TeamAnalysis; all: TeamAnalysis[] }) {
  const groups = Object.keys(me.groups).sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  return (
    <div className="strength">
      {groups.map((g) => {
        const grp = me.groups[g];
        const max = Math.max(grp.ppg, grp.leagueAvg, ...all.map((t) => t.groups[g]?.ppg ?? 0)) || 1;
        const cls = grp.ppg >= grp.leagueAvg ? "above" : "below";
        const diff = grp.ppg - grp.leagueAvg;
        return (
          <div className="strength-row" key={g} title={`${g}: your starters ${f1(grp.ppg)} ppg vs league average ${f1(grp.leagueAvg)} (${grp.count} slot${grp.count === 1 ? "" : "s"})`}>
            <div className="strength-label">{g}</div>
            <div className="bar-track">
              <div className={`bar-fill ${cls}`} style={{ width: `${(grp.ppg / max) * 100}%` }} />
              <div className="bar-avg" style={{ left: `${(grp.leagueAvg / max) * 100}%` }} title={`League avg ${f1(grp.leagueAvg)}`} />
            </div>
            <div className="strength-nums">
              <span className="strong">{f1(grp.ppg)}</span>
              <span className={`small ${diff >= 0 ? "pos" : "neg"}`}>
                {diff >= 0 ? "+" : ""}
                {f1(diff)}
              </span>
            </div>
            <RankBadge rank={grp.rank} of={all.length} />
          </div>
        );
      })}
      <div className="legend muted small">
        <span className="legend-avg" /> league average
      </div>
    </div>
  );
}
