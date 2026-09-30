import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, MOCK, type Active, type Analysis, type ImportResult } from "./api";
import { ErrorBox, Loading } from "./components/common";
import { ago } from "./lib/format";
import { loadActive, loadImportBackup, saveActive } from "./lib/storage";
import { useAsync, type AsyncState } from "./lib/useAsync";
import { ConnectTab } from "./tabs/ConnectTab";
import { MyTeamTab } from "./tabs/MyTeamTab";
import { TradesTab } from "./tabs/TradesTab";
import { TargetsTab } from "./tabs/TargetsTab";
import { ValuesTab } from "./tabs/ValuesTab";
import { WaiversTab } from "./tabs/WaiversTab";

const TABS = [
  { id: "connect", label: "Connect" },
  { id: "team", label: "My Team" },
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

export function App() {
  const [active, setActiveRaw] = useState<Active | null>(() => loadActive());
  const [justConnected, setJustConnected] = useState(false);
  const [tab, setTabRaw] = useState<TabId>(() => tabFromHash() ?? (loadActive() ? "team" : "connect"));

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

  const setActive = useCallback((a: Active | null) => {
    saveActive(a);
    setActiveRaw(a);
  }, []);

  const state = useAsync(() => api.state(), []);
  const activeKey = active ? `${active.provider}/${active.id}/${active.team ?? ""}` : "";
  const analysis = useAsync(() => (active ? api.analysis(active) : null), [activeKey]);

  // Imported leagues live in the server's .data/, which hosted servers lose on restart:
  // re-upload this browser's backup once when the server no longer knows the league.
  const [restored, setRestored] = useState<string>();
  useEffect(() => {
    if (active?.provider !== "import" || analysis.error?.status !== 404 || restored === active.id) return;
    const backup = loadImportBackup(active.id);
    setRestored(active.id);
    if (backup) api.importPost(backup).then(() => analysis.reload(), () => undefined);
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
        </div>
      </header>

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
                <MyTeamTab analysis={a} />
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
