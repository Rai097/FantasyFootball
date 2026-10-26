import type { Analysis, VP } from "../api";
import { Empty, PosBadge, Stat } from "../components/common";
import { ColumnHelp } from "../components/HelpTip";
import { LineupTable } from "../components/LineupTable";
import { InjuryDot } from "../components/PlayerChip";
import { PositionStrength } from "../components/PositionStrength";
import { f1, ordinal, record } from "../lib/format";

export function MyTeamTab({ analysis, onOpenLeague }: { analysis: Analysis; onOpenLeague?: () => void }) {
  const { league, teams, myTeamId } = analysis;
  const me = teams.find((t) => t.team.id === myTeamId);
  if (!me) return <Empty>Team {myTeamId} was not found in this league. Pick your team on the Connect tab.</Empty>;

  const starters = me.lineup.map((s) => s.player as VP | null).filter((p): p is VP => !!p);
  const everyone = [...starters, ...me.bench];
  const { currentWeek, finalWeek } = league.settings;
  const weeks: { week: number; count: number; players: VP[] }[] = [];
  for (let w = currentWeek; w <= finalWeek; w++) {
    const players = starters.filter((p) => p.bye === w);
    // Prefer the server's count; fall back to counting starters' bye weeks locally.
    const count = me.byeExposure?.[w] ?? players.length;
    weeks.push({ week: w, count, players });
  }
  const injured = everyone.filter((p) => p.injury && p.injury.status);
  const extraFlags = (me.injuryFlags ?? []).filter((f) => !injured.some((p) => f.includes(p.name)));

  return (
    <div className="stack">
      <section className="stat-row">
        <Stat
          label="Power rank"
          value={`${ordinal(me.powerRank)}`}
          sub={`of ${teams.length} · see League ›`}
          why="Place by power score (0.7 × starter ppg + 0.3 × bench strength). Tap to see who is above you and why."
          onClick={onOpenLeague}
        />
        <Stat
          label="Record"
          value={record(me.team.record)}
          sub={me.team.record?.pointsFor != null ? `${f1(me.team.record.pointsFor)} PF` : undefined}
          why={
            me.team.record
              ? "Wins and losses (and points scored) from the league standings at the last update."
              : "Unknown: the standings were not captured. Re-import the league with the latest bookmarklet to read them."
          }
        />
        <Stat label="Starter ppg" value={f1(me.starterPpg)} why="Projected points per week from your best legal lineup (injured players discounted)." />
        <Stat label="Bench value" value={f1(me.benchValue)} why="Sum of your bench players' 0–100 trade values: what you could deal without touching the lineup." />
        <Stat label="Total value" value={f1(me.totalValue)} why="Sum of every rostered player's 0–100 trade value (starters plus bench)." />
      </section>

      {me.team.unmatched.length > 0 && (
        <div className="notice warn">
          <b>Not matched, left out of every number:</b> {me.team.unmatched.join(", ")}
        </div>
      )}

      <div className="grid-main team-grid">
        <section className="card">
          <h2>
            Lineup &amp; bench <span className="muted small">{me.team.name}</span>
          </h2>
          <LineupTable lineup={me.lineup} bench={me.bench} irIds={me.team.irPlayerIds} />
        </section>

        <div className="stack side-stack">
          <section className="card">
            <h2>Position strength</h2>
            <PositionStrength me={me} all={teams} />
            <div className="chips-block">
              <div>
                <span className="label">Needs</span>
                {me.needs.length ? me.needs.map((n) => <span key={n} className="tag need">{n}</span>) : <span className="muted small">none</span>}
              </div>
              <div>
                <span className="label">Surplus</span>
                {me.surplus.length ? me.surplus.map((n) => <span key={n} className="tag surplus">{n}</span>) : <span className="muted small">none</span>}
              </div>
            </div>
          </section>

          <section className="card">
            <h2>
              <ColumnHelp tip={`Starters on bye in each remaining week (red = 2 or more). Dashed weeks, after week ${league.settings.regularSeasonEnd}, are playoffs.`}>
                Byes &amp; injuries
              </ColumnHelp>
            </h2>
            <div className="bye-grid" aria-label="Starters on bye by week">
              {weeks.map((w) => (
                <div
                  key={w.week}
                  className={`bye-cell${w.count >= 2 ? " bad" : w.count === 1 ? " warn" : ""}${w.week > league.settings.regularSeasonEnd ? " playoff" : ""}`}
                  title={w.count ? `Week ${w.week}: ${w.players.map((p) => p.name).join(", ") || `${w.count} starter(s)`} on bye` : `Week ${w.week}: no starters on bye`}
                >
                  <span className="bye-week">W{w.week}</span>
                  <span className="bye-count">{w.count || "0"}</span>
                </div>
              ))}
            </div>
            <ul className="inj-list bye-list" aria-label="Starters on bye">
              {weeks
                .filter((w) => w.players.length > 0)
                .map((w) => (
                  <li key={w.week}>
                    <span className={`bye-wk${w.players.length >= 2 ? " neg" : ""}`}>W{w.week}</span>
                    <span className="bye-names">{w.players.map((p) => p.name).join(", ")}</span>
                  </li>
                ))}
            </ul>
            {extraFlags.length > 0 && (
              <ul className="inj-list">
                {extraFlags.map((f) => (
                  <li key={f} className="muted">
                    {f}
                  </li>
                ))}
              </ul>
            )}
            {injured.length ? (
              <ul className="inj-list">
                {injured.map((p) => (
                  <li key={p.id}>
                    <InjuryDot player={p} />
                    <PosBadge pos={p.pos} /> <span className="strong">{p.name}</span>{" "}
                    <span className="muted">
                      {p.injury!.status}
                      {p.injury!.detail ? ` – ${p.injury!.detail}` : ""}
                    </span>
                    {starters.includes(p) && <span className="tag need">starter</span>}
                  </li>
                ))}
              </ul>
            ) : (
              extraFlags.length === 0 && <div className="muted small">No injury designations on your roster.</div>
            )}
          </section>
        </div>
      </div>

      {analysis.notes && analysis.notes.length > 0 && (
        <ul className="muted small footnote plain-list">
          {analysis.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
