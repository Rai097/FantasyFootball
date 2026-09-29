import type { Analysis, VP } from "../api";
import { Empty, PosBadge } from "../components/common";
import { BenchList, LineupTable } from "../components/LineupTable";
import { InjuryDot } from "../components/PlayerChip";
import { PositionStrength } from "../components/PositionStrength";
import { f1, ordinal, record } from "../lib/format";

export function MyTeamTab({ analysis }: { analysis: Analysis }) {
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
  const ranked = [...teams].sort((a, b) => a.powerRank - b.powerRank);

  return (
    <div className="stack">
      <section className="stat-row">
        <Stat label="Power rank" value={`${ordinal(me.powerRank)}`} sub={`of ${teams.length}`} />
        <Stat label="Record" value={record(me.team.record)} sub={me.team.record?.pointsFor != null ? `${f1(me.team.record.pointsFor)} PF` : undefined} />
        <Stat label="Starter ppg" value={f1(me.starterPpg)} />
        <Stat label="Bench value" value={f1(me.benchValue)} />
        <Stat label="Total value" value={f1(me.totalValue)} />
      </section>

      {me.team.unmatched.length > 0 && (
        <div className="notice warn">
          Could not match {me.team.unmatched.length} rostered player{me.team.unmatched.length > 1 ? "s" : ""} to the player database: {me.team.unmatched.join(", ")}.
          They are ignored in all calculations.
        </div>
      )}

      <div className="grid-main">
        <section className="card">
          <h2>
            Starting lineup <span className="muted small">{me.team.name}</span>
          </h2>
          <LineupTable lineup={me.lineup} />
          <h3>Bench</h3>
          <BenchList bench={me.bench} />
        </section>

        <div className="stack">
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
            <h2>Byes &amp; injuries</h2>
            <div className="bye-grid" aria-label="Starters on bye by week">
              {weeks.map((w) => (
                <div
                  key={w.week}
                  className={`bye-cell${w.count >= 2 ? " bad" : w.count === 1 ? " warn" : ""}${w.week > league.settings.regularSeasonEnd ? " playoff" : ""}`}
                  title={w.count ? `Week ${w.week}: ${w.players.map((p) => p.name).join(", ") || `${w.count} starter(s)`} on bye` : `Week ${w.week}: no starters on bye`}
                >
                  <span className="bye-week">W{w.week}</span>
                  <span className="bye-count">{w.count || "·"}</span>
                </div>
              ))}
            </div>
            <p className="muted small">Starters on bye per week. Weeks after {league.settings.regularSeasonEnd} are playoffs.</p>
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
              extraFlags.length === 0 && <p className="muted">No injury designations on your roster.</p>
            )}
          </section>
        </div>
      </div>

      <section className="card">
        <h2>League power rankings</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Team</th>
                <th>Record</th>
                <th className="num">Starter ppg</th>
                <th className="num">Bench value</th>
                <th className="num hide-sm">Power score</th>
                <th className="hide-sm">Needs</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((t) => (
                <tr key={t.team.id} className={t.team.id === myTeamId ? "mine" : ""}>
                  <td className="num">{t.powerRank}</td>
                  <td>
                    <div className="strong">{t.team.name}</div>
                    <div className="muted small">{t.team.owner}</div>
                  </td>
                  <td>{record(t.team.record)}</td>
                  <td className="num">{f1(t.starterPpg)}</td>
                  <td className="num">{f1(t.benchValue)}</td>
                  <td className="num hide-sm">{f1(t.powerScore)}</td>
                  <td className="hide-sm">
                    {t.needs.map((n) => (
                      <span key={n} className="tag need">
                        {n}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">Power score = 0.7 × starter ppg + 0.3 × bench strength; ties broken by record.</p>
      </section>

      {analysis.notes && analysis.notes.length > 0 && <p className="muted small footnote">{analysis.notes.join(" · ")}</p>}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
