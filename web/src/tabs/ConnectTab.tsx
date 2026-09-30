import { useState } from "react";
import { api, type Active, type Analysis, type AppState, type YahooLeague } from "../api";
import { ErrorBox, Loading } from "../components/common";
import type { ApiError } from "../lib/errors";
import { ago, record } from "../lib/format";
import { toApiError, useAsync, type AsyncState } from "../lib/useAsync";
import { ImportSection } from "./ImportSection";

interface Props {
  state: AsyncState<AppState>;
  active: Active | null;
  analysis: AsyncState<Analysis>;
  justConnected: boolean;
  onChoose: (a: Active | null) => void;
  onGo: () => void;
}

export function ConnectTab({ state, active, analysis, justConnected, onChoose, onGo }: Props) {
  return (
    <div className="stack">
      {justConnected && <div className="notice good">Yahoo connected. Pick your league below.</div>}
      {state.error && <ErrorBox error={state.error} onRetry={state.reload} />}

      {active && <CurrentLeague active={active} analysis={analysis} onChoose={onChoose} onGo={onGo} />}

      <div className="grid-2">
        <section className="card">
          <h2>Demo league</h2>
          <p className="muted">
            A 12-team half-PPR league drafted from real expert rankings. Everything works offline from Yahoo — the fastest way to see how the
            model thinks.
          </p>
          <button
            className="btn primary"
            onClick={() => {
              onChoose({ provider: "demo", id: "42" });
              onGo();
            }}
          >
            Use demo league
          </button>
        </section>

        <section className="card">
          <h2>Yahoo Fantasy (API)</h2>
          <p className="muted small">
            Yahoo now approves API apps one by one (1–2 weeks). Until then, use <a href="#import">Import from Yahoo (browser)</a> below.
          </p>
          {state.loading && !state.data && <Loading label="Checking server…" />}
          {state.data && <YahooSection state={state.data} reloadState={state.reload} active={active} onChoose={onChoose} />}
          {state.error && !state.data && <p className="muted">Yahoo status is unavailable until the server responds.</p>}
        </section>
      </div>

      <ImportSection active={active} onChoose={onChoose} onGo={onGo} onSettingsSaved={analysis.reload} />

      {state.data && (
        <p className="muted small">
          Season {state.data.season} · week {state.data.currentWeek} · regular season ends week {state.data.lastRegularWeek} ·{" "}
          {state.data.playerCount.toLocaleString()} players · data built {ago(state.data.dbBuiltAt)}
        </p>
      )}
    </div>
  );
}

function CurrentLeague({ active, analysis, onChoose, onGo }: { active: Active; analysis: AsyncState<Analysis>; onChoose: Props["onChoose"]; onGo: () => void }) {
  // The team list comes from the League itself so the picker works even when analysis fails.
  const league = useAsync(() => api.league(active), [active.provider, active.id]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState<ApiError>();
  const teams = league.data?.teams ?? [];
  const team = active.team ?? league.data?.myTeamId ?? analysis.data?.myTeamId ?? "";

  return (
    <section className="card current">
      <div className="row between wrap">
        <div>
          <div className="eyebrow">Active league · {active.provider === "demo" ? "Demo" : active.provider === "import" ? "Imported from Yahoo" : "Yahoo"}</div>
          <h2 className="no-margin">{league.data?.settings.name ?? active.id}</h2>
          {league.data && (
            <div className="muted small">
              {league.data.settings.numTeams} teams · week {league.data.settings.currentWeek} · {active.provider === "import" ? "imported" : "fetched"}{" "}
              {ago(league.data.fetchedAt)}
            </div>
          )}
        </div>
        <div className="row gap wrap">
          {active.provider === "yahoo" && (
            <button
              className="btn"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                setRefreshErr(undefined);
                try {
                  await api.league(active, true);
                  league.reload();
                  analysis.reload();
                } catch (e) {
                  setRefreshErr(toApiError(e));
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              {refreshing ? "Refreshing…" : "Refresh from Yahoo"}
            </button>
          )}
          <button className="btn" onClick={() => onChoose(null)}>
            Clear
          </button>
          <button className="btn primary" onClick={onGo}>
            Open My Team
          </button>
        </div>
      </div>
      {league.loading && !league.data && <Loading label="Loading teams…" />}
      {league.error && <ErrorBox error={league.error} onRetry={league.reload} />}
      {refreshErr && <ErrorBox error={refreshErr} />}
      {teams.length > 0 && (
        <label className="field">
          <span>Your team</span>
          <select value={team} onChange={(e) => onChoose({ ...active, team: e.target.value })}>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.owner ? ` (${t.owner})` : ""} {record(t.record)}
                {t.id === league.data?.myTeamId ? " · you" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}

function YahooSection({ state, reloadState, active, onChoose }: { state: AppState; reloadState: () => void; active: Active | null; onChoose: Props["onChoose"] }) {
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError>();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
    } catch (e) {
      setErr(toApiError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!state.yahooConfigured) {
    return (
      <div>
        <p>Yahoo isn't configured on this machine yet.</p>
        <ol className="steps">
          <li>
            Create a Yahoo developer app (Fantasy Sports <b>read</b> permission, redirect URI <code>oob</code>).
          </li>
          <li>
            Create a <code>.env</code> file in the project folder with <code>YAHOO_CLIENT_ID</code> and <code>YAHOO_CLIENT_SECRET</code>.
          </li>
          <li>Restart the server, then reload this page.</li>
        </ol>
        <p className="muted small">
          Full walkthrough with screenshots: <code>docs/YAHOO_SETUP.md</code> in the project folder.
        </p>
      </div>
    );
  }

  if (!state.yahooConnected) {
    return (
      <div className="stack-sm">
        <p className="muted">Sign in to Yahoo and allow read access to your fantasy leagues.</p>
        {!awaitingCode && (
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const { url, mode } = await api.yahooStart();
                if (mode === "redirect") {
                  // Yahoo sends the browser back to /auth/yahoo/callback, so stay in this tab.
                  window.location.assign(url);
                  return;
                }
                window.open(url, "_blank", "noopener");
                setAwaitingCode(true);
              })
            }
          >
            {busy ? "Opening Yahoo…" : "Connect Yahoo"}
          </button>
        )}
        {awaitingCode && (
          <form
            className="stack-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (!code.trim()) return;
              run(async () => {
                await api.yahooCode(code.trim());
                setAwaitingCode(false);
                setCode("");
                reloadState();
              });
            }}
          >
            <label className="field">
              <span>Paste the code Yahoo shows after you click Agree</span>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. abc12de" autoFocus autoComplete="off" />
            </label>
            <div className="row gap">
              <button className="btn primary" type="submit" disabled={busy || !code.trim()}>
                {busy ? "Connecting…" : "Submit code"}
              </button>
              <button className="btn" type="button" onClick={() => setAwaitingCode(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {err && <ErrorBox error={err} />}
      </div>
    );
  }

  return (
    <YahooLeagues
      active={active}
      onChoose={onChoose}
      onDisconnect={() =>
        run(async () => {
          await api.yahooDisconnect();
          if (active?.provider === "yahoo") onChoose(null);
          reloadState();
        })
      }
      err={err}
      busy={busy}
    />
  );
}

function YahooLeagues({
  active,
  onChoose,
  onDisconnect,
  err,
  busy,
}: {
  active: Active | null;
  onChoose: Props["onChoose"];
  onDisconnect: () => void;
  err?: ApiError;
  busy: boolean;
}) {
  const leagues = useAsync(() => api.yahooLeagues(), []);
  return (
    <div className="stack-sm">
      <div className="row between">
        <span className="pill status good">
          <span className="status-dot" aria-hidden />
          Connected
        </span>
        <button className="btn small" onClick={onDisconnect} disabled={busy}>
          Disconnect
        </button>
      </div>
      {leagues.loading && <Loading label="Loading your Yahoo leagues…" />}
      {leagues.error && <ErrorBox error={leagues.error} onRetry={leagues.reload} />}
      {leagues.data && leagues.data.length === 0 && <p className="muted">No NFL leagues found for this Yahoo account this season.</p>}
      {leagues.data && leagues.data.length > 0 && (
        <ul className="league-list">
          {leagues.data.map((l: YahooLeague) => {
            const isActive = active?.provider === "yahoo" && active.id === l.key;
            return (
              <li key={l.key} className={isActive ? "active" : ""}>
                <div>
                  <div className="strong">{l.name}</div>
                  <div className="muted small">
                    {l.season} · {l.numTeams} teams · week {l.currentWeek}
                  </div>
                </div>
                <button className={`btn small${isActive ? "" : " primary"}`} disabled={isActive} onClick={() => onChoose({ provider: "yahoo", id: l.key, team: l.myTeamKey })}>
                  {isActive ? "Active" : "Use"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {err && <ErrorBox error={err} />}
    </div>
  );
}
