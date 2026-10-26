import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, MOCK, setAuthProblemHandler, setCsrf, type Active, type Analysis, type AuthProblem, type ImportResult, type Me } from "./api";
import { AccountMenu } from "./components/AccountMenu";
import { ErrorBox, Loading } from "./components/common";
import { SignIn } from "./components/SignIn";
import type { ApiError } from "./lib/errors";
import { ago } from "./lib/format";
import { loadActive, loadImportBackup, saveActive } from "./lib/storage";
import { useAsync, type AsyncState } from "./lib/useAsync";
import { ConnectTab } from "./tabs/ConnectTab";
import { LeagueTab } from "./tabs/LeagueTab";
import { MyTeamTab } from "./tabs/MyTeamTab";
import { TradesTab } from "./tabs/TradesTab";
import { TargetsTab } from "./tabs/TargetsTab";
import { ValuesTab } from "./tabs/ValuesTab";
import { WaiversTab } from "./tabs/WaiversTab";

const STALE_DAYS = 3;
function staleDays(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? (Date.now() - t) / 86_400_000 : 0;
}

const TABS = [
  { id: "connect", label: "Connect" },
  { id: "team", label: "My Team" },
  { id: "league", label: "League" },
  { id: "trades", label: "Trade Finder" },
  { id: "waivers", label: "Waivers" },
  { id: "targets", label: "Targets" },
  { id: "values", label: "Values" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function tabFromHash(): TabId | null {
  const h = window.location.hash.replace(/^#/, "");
  return (TABS.find((t) => t.id === h)?.id as TabId | undefined) ?? null;
}

/** A user (or an admin viewing as one) always works on their own league and team. */
function scopedActive(me: Me, a: Active | null): Active | null {
  if (!me.scope) return a;
  return { provider: "import", id: me.scope.leagueId, team: me.scope.teamId };
}

/** Auth gate: sign-in screen on 401 / not on the list; the desk once GET /api/auth/me answers. */
export function App() {
  const [problem, setProblem] = useState<AuthProblem | null>(() =>
    new URLSearchParams(window.location.search).get("error") === "not_allowed" ? "not_allowed" : null,
  );
  const [me, setMeRaw] = useState<Me>();
  const [meErr, setMeErr] = useState<ApiError>();

  const setMe = useCallback((m: Me | undefined) => {
    setCsrf(m?.csrf ?? "");
    setMeRaw(m);
  }, []);

  const loadMe = useCallback(() => {
    setMeErr(undefined);
    api.me().then(
      (m) => {
        setMe(m);
        setProblem(null);
      },
      (e: ApiError) => {
        if (e.status === 401) setProblem((p) => (p === "not_allowed" ? p : "signin"));
        else if (e.status === 403) setProblem("not_allowed");
        else setMeErr(e);
      },
    );
  }, [setMe]);

  useEffect(() => {
    // The callback lands on /?error=not_allowed: show the message once, keep the URL clean.
    const params = new URLSearchParams(window.location.search);
    if (params.has("error")) {
      params.delete("error");
      const q = params.toString();
      history.replaceState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`);
    }
    setAuthProblemHandler((p) => {
      setProblem(p);
      setMe(undefined);
    });
    loadMe();
    return () => setAuthProblemHandler(undefined);
  }, [loadMe, setMe]);

  if (problem) return <SignIn problem={problem} />;
  if (meErr)
    return (
      <div className="app">
        <main className="main">
          <ErrorBox error={meErr} onRetry={loadMe} />
        </main>
      </div>
    );
  if (!me) return <Loading label="Checking sign-in…" />;
  return (
    <Desk
      key={me.actingAs?.discordId ?? "self"}
      me={me}
      onMe={setMe}
      onSignedOut={() => {
        setMe(undefined);
        setProblem("signin");
      }}
    />
  );
}

function Desk({ me, onMe, onSignedOut }: { me: Me; onMe: (m: Me) => void; onSignedOut: () => void }) {
  const [active, setActiveRaw] = useState<Active | null>(() => scopedActive(me, loadActive()));
  const [justConnected, setJustConnected] = useState(false);
  const [tab, setTabRaw] = useState<TabId>(() => tabFromHash() ?? (scopedActive(me, loadActive()) ? "team" : "connect"));

  const setTab = useCallback((t: TabId) => {
    setTabRaw(t);
    if (window.location.hash !== `#${t}`) history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${t}`);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const t = tabFromHash();
      if (t) setTabRaw(t);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Yahoo redirect-uri mode lands on /?connected=1
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected") === "1") {
      params.delete("connected");
      const q = params.toString();
      history.replaceState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}#connect`);
      setJustConnected(true);
      setTabRaw("connect");
    }
  }, []);

  const setActive = useCallback(
    (a: Active | null) => {
      const next = scopedActive(me, a);
      saveActive(next);
      setActiveRaw(next);
    },
    [me],
  );

  const state = useAsync(() => api.state(), []);
  const activeKey = active ? `${active.provider}/${active.id}/${active.team ?? ""}` : "";
  const analysis = useAsync(() => (active ? api.analysis(active) : null), [activeKey]);

  // Imported leagues live in the server's .data/, which hosted servers lose on restart:
  // re-upload this browser's backup once when the server no longer knows the league.
  // Sends X-CSRF-Token like every write; a 403 means "not your league": stop, no retry (restored is set first).
  const [restored, setRestored] = useState<string>();
  useEffect(() => {
    if (active?.provider !== "import" || analysis.error?.status !== 404 || restored === active.id) return;
    const backup = loadImportBackup(active.id);
    setRestored(active.id);
    if (backup)
      api.importPost(backup).then(
        () => {
          analysis.reload();
          const when = typeof backup === "object" && backup && "importedAt" in backup ? String((backup as { importedAt?: string }).importedAt) : undefined;
          setToast(`Restored your league from this browser's saved copy${when ? ` (imported ${ago(when)})` : ""}. Re-run the import bookmark for current rosters.`);
        },
        () => undefined,
      );
  }, [active, analysis.error, analysis, restored]);

  // Adopt the server's idea of "my team" when none was chosen yet.
  useEffect(() => {
    if (active && !active.team && analysis.data?.myTeamId) setActive({ ...active, team: analysis.data.myTeamId });
  }, [active, analysis.data, setActive]);

  // Short confirmation after an import (e.g. "League updated: 2 roster changes").
  const [toast, setToast] = useState<string>();
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const onImported = useCallback(
    (r: ImportResult) => {
      // Same league id → same `active`, so reload explicitly or the old rosters stay on screen.
      state.reload();
      analysis.reload();
      setTab("team");
      const n = r.changes?.playersChanged ?? 0;
      setToast(
        r.updated
          ? n
            ? `League updated: ${n} roster change${n === 1 ? "" : "s"}`
            : "League updated: no roster changes detected"
          : `League imported: ${r.teams.length} team${r.teams.length === 1 ? "" : "s"}`,
      );
    },
    [state, analysis, setTab],
  );

  const league = analysis.data?.league;
  const week = league?.settings.currentWeek ?? state.data?.currentWeek;

  const status = useMemo(() => {
    if (state.error) return { cls: "bad", text: "Server offline" };
    if (!state.data) return { cls: "neutral", text: "Checking…" };
    if (active?.provider === "yahoo") return state.data.yahooConnected ? { cls: "good", text: "Yahoo connected" } : { cls: "warn", text: "Yahoo disconnected" };
    if (active?.provider === "demo") return { cls: "neutral", text: "Demo league" };
    if (active?.provider === "import") return { cls: "neutral", text: "Imported league" };
    return state.data.yahooConnected ? { cls: "good", text: "Yahoo connected" } : { cls: "neutral", text: "Not connected" };
  }, [state.data, state.error, active]);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="logo" aria-hidden>
            TD
          </span>
          <span className="app-name">Trade Desk</span>
        </div>
        <div className="header-meta">
          <span className="league-name" title={league?.settings.name}>
            {league?.settings.name ?? (active ? (analysis.loading ? "Loading league…" : "League unavailable") : "No league selected")}
          </span>
          {week != null && <span className="pill">Week {week}</span>}
          {state.data && <span className="pill muted" title={`Player database built ${state.data.dbBuiltAt}`}>Data {ago(state.data.dbBuiltAt)}</span>}
          <span className={`pill status ${status.cls}`}>
            <span className="status-dot" aria-hidden />
            {status.text}
          </span>
          {MOCK && <span className="pill mock" title="All data is served by web/src/mock.ts">Mock data</span>}
          <AccountMenu me={me} onMe={onMe} onSignedOut={onSignedOut} />
        </div>
      </header>

      {me.actingAs && (
        <div className="notice warn banner row between wrap">
          <span>
            Viewing as <b>{me.actingAs.note ?? `user …${me.actingAs.discordId.slice(-4)}`}</b>: their league and team only.
          </span>
          <button className="btn small" onClick={() => api.actAs(null).then(onMe, () => undefined)}>
            Back to admin
          </button>
        </div>
      )}

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main className="main">
        {tab === "connect" && (
          <ConnectTab
            me={me}
            state={state}
            active={active}
            analysis={analysis}
            justConnected={justConnected}
            onChoose={(a) => {
              setActive(a);
            }}
            onGo={() => setTab("team")}
            onImported={onImported}
          />
        )}
        {league?.import && staleDays(league.import.importedAt) >= STALE_DAYS && (

          <div className="notice warn banner">
            Rosters were imported <b>{ago(league.import.importedAt)}</b>, so trades, adds and drops since then are missing. Open your Yahoo
            league, click the <b>Trade Desk import</b> bookmark and paste the result on the{" "}
            <button className="link-btn" onClick={() => setTab("connect")}>
              Connect tab
            </button>{" "}
            to refresh. Your settings are kept.
          </div>
        )}
        {tab !== "connect" && league?.import?.settingsSource === "default" && (
          <div className="notice warn banner">
            This imported league uses Yahoo's <b>default</b> settings because its settings page could not be read. Check scoring and roster
            slots on the{" "}
            <button className="link-btn" onClick={() => setTab("connect")}>
              Connect tab
            </button>
            .
          </div>
        )}
        {tab !== "connect" && (
          <NeedLeague active={active} analysis={analysis} onConnect={() => setTab("connect")}>
            {(a, act) =>
              tab === "team" ? (
                <MyTeamTab analysis={a} onOpenLeague={() => setTab("league")} />
              ) : tab === "league" ? (
                <LeagueTab analysis={a} active={act} />
              ) : tab === "trades" ? (
                <TradesTab analysis={a} active={act} />
              ) : tab === "waivers" ? (
                <WaiversTab analysis={a} active={act} />
              ) : tab === "targets" ? (
                <TargetsTab analysis={a} active={act} />
              ) : (
                <ValuesTab analysis={a} active={act} />
              )
            }
          </NeedLeague>
        )}
      </main>
      {toast && (
        <div className="toast" role="status" onClick={() => setToast(undefined)}>
          {toast}
        </div>
      )}
      <footer className="footer">
        Numbers are rest-of-season projections under your league's scoring. Tap <span className="why-btn inline">?</span> for how each one is made.
      </footer>
    </div>
  );
}

function NeedLeague({
  active,
  analysis,
  onConnect,
  children,
}: {
  active: Active | null;
  analysis: AsyncState<Analysis>;
  onConnect: () => void;
  children: (a: Analysis, active: Active & { team: string }) => ReactNode;
}) {
  if (!active)
    return (
      <div className="card center">
        <p>No league selected yet.</p>
        <button className="btn primary" onClick={onConnect}>
          Go to Connect
        </button>
      </div>
    );
  if (analysis.error) return <ErrorBox error={analysis.error} onRetry={analysis.reload} />;
  if (!analysis.data) return <Loading label="Analysing league…" />;
  const team = active.team ?? analysis.data.myTeamId;
  return <>{children(analysis.data, { ...active, team })}</>;
}
