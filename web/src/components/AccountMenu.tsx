// Header account controls: avatar + name, Sign out, and for admins a "View as" picker (Admin / each user).
import { useState } from "react";
import { api, type Me } from "../api";
import { useAsync } from "../lib/useAsync";

export function AccountMenu({ me, onMe, onSignedOut }: { me: Me; onMe: (m: Me) => void; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const isAdmin = me.role === "admin";
  const access = useAsync(() => (isAdmin && !me.dev ? api.access() : null), [isAdmin, me.dev]);
  const users = access.data?.users ?? [];

  return (
    <div className="account">
      {isAdmin && users.length > 0 && (
        <label className="view-as" title="See the app exactly as this user sees it (their league and team only).">
          <span className="muted small">View as</span>
          <select
            value={me.actingAs?.discordId ?? ""}
            disabled={busy}
            onChange={async (e) => {
              setBusy(true);
              try {
                onMe(await api.actAs(e.target.value || null));
              } catch {
                /* the picker keeps the current value; the API error is rare (user removed meanwhile) */
              } finally {
                setBusy(false);
              }
            }}
          >
            <option value="">Admin</option>
            {users.map((u) => (
              <option key={u.discordId} value={u.discordId}>
                {u.note ?? `User …${u.discordId.slice(-4)}`}
              </option>
            ))}
          </select>
        </label>
      )}
      <span className="pill user-chip" title={me.dev ? "Dev mode: no Discord sign-in on this server" : `Signed in with Discord${isAdmin ? " (admin)" : ""}`}>
        {me.avatarUrl ? <img className="avatar" src={me.avatarUrl} alt="" width={20} height={20} /> : <span className="avatar placeholder" aria-hidden />}
        {me.name}
      </span>
      {!me.dev && (
        <button
          className="btn small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.logout();
            } finally {
              setBusy(false);
              onSignedOut();
            }
          }}
        >
          Sign out
        </button>
      )}
    </div>
  );
}
