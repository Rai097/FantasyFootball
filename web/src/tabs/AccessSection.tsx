// Connect → "Who can sign in" (league owner only): give a Discord account one team so that manager can sign in and
// see their own team. Accounts that tried to sign in but aren't listed show first, ready to assign with one tap.
// The server keeps the list in .data/access.json (never in the repo); admins are changed only by hand on the server.
import { useState } from "react";
import { api, type AccessOverview } from "../api";
import { ErrorBox, Loading } from "../components/common";
import { Disclosure } from "../components/ExpandableRow";
import type { ApiError } from "../lib/errors";
import { accessView, cleanDiscordId, personLabel } from "../lib/accessView";
import { ago } from "../lib/format";
import { toApiError, useAsync } from "../lib/useAsync";

export function AccessSection({ leagueId }: { leagueId?: string }) {
  const res = useAsync(() => api.access(), []);
  const [data, setData] = useState<AccessOverview>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError>();
  const o = data ?? res.data;
  const v = o ? accessView(o, leagueId) : null;

  /** true when saved (the form clears only then). */
  const run = async (fn: () => Promise<AccessOverview>): Promise<boolean> => {
    setBusy(true);
    setErr(undefined);
    try {
      setData(await fn());
      return true;
    } catch (e) {
      setErr(toApiError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const assign = (discordId: string, teamId: string, note?: string) => (v ? run(() => api.accessSet(discordId, { leagueId: v.leagueId, teamId, note })) : Promise.resolve(false));

  return (
    <section className="card stack-sm access-card">
      <div className="row between wrap">
        <h2 className="no-margin">Who can sign in</h2>
        {v && <span className="muted small">{v.summary}</span>}
      </div>
      {res.loading && !o && <Loading label="Loading the access list…" />}
      {res.error && !o && <ErrorBox error={res.error} onRetry={res.reload} />}
      {o && !v && <p className="muted small no-margin">Import the league first, then assign each team.</p>}
      {o && v && (
        <>
          {o.requests.length > 0 && (
            <div className="stack-sm">
              <h3 className="no-margin">Tried to sign in</h3>
              <ul className="access-list">
                {o.requests.map((r) => (
                  <RequestRow key={r.discordId} r={r} teams={v.rows} busy={busy} onAssign={(teamId) => void assign(r.discordId, teamId, r.name || undefined)} />
                ))}
              </ul>
            </div>
          )}
          {v.stale.length > 0 && (
            <div className="notice warn">
              {v.stale.length} listed account{v.stale.length > 1 ? "s point" : " points"} to a team that isn't in the league any more: remove or reassign below.
            </div>
          )}
          <Disclosure title={`Teams (${v.rows.length})`}>
            <ul className="access-list">
              {v.rows.map((r) => (
                <li key={r.teamId} className="access-row">
                  <span className="strong access-team">{r.teamName}</span>
                  <span className="row gap wrap">
                    {r.people.length === 0 && <span className="muted small">no one</span>}
                    {r.people.map((u) => (
                      <span key={u.discordId} className="pill access-person" title={`Discord ID ${u.discordId}`}>
                        {personLabel(u)}
                        <RemoveButton label={personLabel(u)} team={r.teamName} busy={busy} onRemove={() => void run(() => api.accessRemove(u.discordId))} />
                      </span>
                    ))}
                  </span>
                </li>
              ))}
              {v.stale.map((u) => (
                <li key={u.discordId} className="access-row">
                  <span className="strong access-team">Team {u.teamId} (gone)</span>
                  <span className="pill access-person" title={`Discord ID ${u.discordId}`}>
                    {personLabel(u)}
                    <RemoveButton label={personLabel(u)} team={`team ${u.teamId}`} busy={busy} onRemove={() => void run(() => api.accessRemove(u.discordId))} />
                  </span>
                </li>
              ))}
            </ul>
          </Disclosure>
          <AddForm teams={v.rows} busy={busy} onAdd={(id, teamId, note) => assign(id, teamId, note)} />
        </>
      )}
      {err && <ErrorBox error={err} />}
    </section>
  );
}

function RequestRow({ r, teams, busy, onAssign }: { r: AccessOverview["requests"][number]; teams: { teamId: string; teamName: string }[]; busy: boolean; onAssign: (teamId: string) => void }) {
  const [team, setTeam] = useState("");
  return (
    <li className="access-row">
      <span className="access-team">
        <span className="strong">{r.name || "Discord user"}</span>{" "}
        <span className="muted small" title={`Discord ID ${r.discordId}`}>
          {ago(r.at)}
        </span>
      </span>
      <span className="row gap wrap">
        <select aria-label={`Team for ${r.name || r.discordId}`} value={team} onChange={(e) => setTeam(e.target.value)}>
          <option value="">Pick a team…</option>
          {teams.map((t) => (
            <option key={t.teamId} value={t.teamId}>
              {t.teamName}
            </option>
          ))}
        </select>
        <button className="btn primary tap" disabled={busy || !team} onClick={() => onAssign(team)}>
          Allow
        </button>
      </span>
    </li>
  );
}

function RemoveButton({ label, team, busy, onRemove }: { label: string; team: string; busy: boolean; onRemove: () => void }) {
  return (
    <button
      className="btn small tap access-remove"
      aria-label={`Remove ${label}`}
      title="Remove: they can't sign in any more"
      disabled={busy}
      onClick={() => {
        if (confirm(`Remove ${label} from ${team}? They won't be able to sign in.`)) onRemove();
      }}
    >
      ✕
    </button>
  );
}

function AddForm({ teams, busy, onAdd }: { teams: { teamId: string; teamName: string }[]; busy: boolean; onAdd: (id: string, teamId: string, note?: string) => Promise<boolean> }) {
  const [id, setId] = useState("");
  const [team, setTeam] = useState("");
  const [note, setNote] = useState("");
  const clean = cleanDiscordId(id);
  return (
    <Disclosure title="Add by Discord ID">
      <form
        className="stack-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!clean || !team) return;
          if (await onAdd(clean, team, note.trim() || undefined)) {
            setId("");
            setNote("");
            setTeam("");
          }
        }}
      >
        <div className="access-form">
          <label className="field">
            <span>Discord user ID</span>
            <input value={id} onChange={(e) => setId(e.target.value)} inputMode="numeric" placeholder="e.g. 123456789012345678" autoComplete="off" />
          </label>
          <label className="field">
            <span>Team</span>
            <select value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">Pick a team…</option>
              {teams.map((t) => (
                <option key={t.teamId} value={t.teamId}>
                  {t.teamName}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Name (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={80} placeholder="Who it is" autoComplete="off" />
          </label>
        </div>
        {id && !clean && <div className="muted small">A Discord user ID is only digits (Discord: Settings → Advanced → Developer Mode, then right-click the name → Copy User ID).</div>}
        <button className="btn primary tap" type="submit" disabled={busy || !clean || !team}>
          Allow sign-in
        </button>
      </form>
    </Disclosure>
  );
}
