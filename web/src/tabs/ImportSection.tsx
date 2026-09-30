// Connect tab → "Import from Yahoo (browser)": bookmarklet link, paste box
// (bookmarklet JSON or copied roster text), imported-league list, settings editor.
// Guide for users: docs/IMPORT.md (served at /api/docs/import).
import { useEffect, useRef, useState } from "react";
import { api, type Active, type ImportResult, type ImportSummary, type StoredImport } from "../api";
import { ErrorBox, Loading } from "../components/common";
import { ApiError } from "../lib/errors";
import { ago } from "../lib/format";
import { toApiError, useAsync } from "../lib/useAsync";

interface Props {
  active: Active | null;
  onChoose: (a: Active | null) => void;
  onGo: () => void;
  onSettingsSaved: () => void;
}

export function ImportSection({ active, onChoose, onGo, onSettingsSaved }: Props) {
  const list = useAsync(() => api.imports(), []);
  const activeImport = active?.provider === "import" ? active.id : undefined;

  return (
    <section className="card stack-sm" id="import">
      <div className="row between wrap">
        <h2 className="no-margin">Import from Yahoo (browser)</h2>
        <a className="small" href="/api/docs/import" target="_blank" rel="noopener">
          Step-by-step guide
        </a>
      </div>
      <p className="muted no-margin">
        No Yahoo API needed: a bookmark reads your league's pages while you are logged in to Yahoo, and you paste the result here. Only you
        run it, on your own league pages.
      </p>
      <div className="grid-2">
        <BookmarkletCard />
        <PasteCard
          imports={list.data ?? []}
          activeImport={activeImport}
          onImported={(r) => {
            list.reload();
            onChoose({ provider: "import", id: r.id, team: r.myTeamId ?? r.teams[0]?.id });
            onGo();
          }}
        />
      </div>
      {activeImport && <ImportSettings key={activeImport} id={activeImport} active={active!} onChoose={onChoose} onSaved={() => (list.reload(), onSettingsSaved())} />}
      <ImportList list={list.data} loading={list.loading} error={list.error} reload={list.reload} active={active} onChoose={onChoose} />
    </section>
  );
}

function BookmarkletCard() {
  const ref = useRef<HTMLAnchorElement>(null);
  const bm = useAsync(() => api.bookmarkletUrl(), []);
  useEffect(() => {
    // Set javascript: href imperatively (React warns about javascript: URLs in JSX).
    if (ref.current && bm.data) ref.current.setAttribute("href", bm.data.url);
  }, [bm.data]);
  return (
    <div className="stack-sm">
      <h3 className="no-margin">1 · Get the data from Yahoo</h3>
      <ol className="steps">
        <li>
          Drag this button to your browser's bookmarks bar:{" "}
          {bm.data ? (
            <a ref={ref} className="btn primary bookmarklet" onClick={(e) => (e.preventDefault(), alert("Drag this button to your bookmarks bar, then click it while on your Yahoo league page."))}>
              Trade Desk import
            </a>
          ) : bm.loading ? (
            <span className="muted">loading…</span>
          ) : null}
        </li>
        <li>
          Open your league on <b>football.fantasysports.yahoo.com</b> (any page whose address contains <code>/f1/</code>).
        </li>
        <li>Click the bookmark. A box appears after ~10–30 s with the teams it found.</li>
        <li>
          Click <b>Copy to clipboard</b> (or Download JSON), then paste it in step 2.
        </li>
      </ol>
      {bm.error && <ErrorBox error={bm.error} onRetry={bm.reload} />}
      <p className="muted small no-margin">
        On a phone, bookmarks are awkward: use a desktop browser, or paste roster text instead.
      </p>
    </div>
  );
}

function PasteCard({ imports, activeImport, onImported }: { imports: ImportSummary[]; activeImport?: string; onImported: (r: ImportResult) => void }) {
  const [text, setText] = useState("");
  const [teamName, setTeamName] = useState("");
  const [target, setTarget] = useState<string>(activeImport ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError>();
  const [note, setNote] = useState<string>();
  const trimmed = text.trim();
  const isJson = trimmed.startsWith("{");
  const multi = /^={2,}.+={2,}\s*$/m.test(trimmed);

  const submit = async () => {
    setErr(undefined);
    setNote(undefined);
    let body: unknown;
    if (isJson) {
      try {
        body = JSON.parse(trimmed);
      } catch {
        setErr(new ApiError("That doesn't look like complete JSON.", 400, "Copy again from the bookmarklet box and paste everything, from the first { to the last }."));
        return;
      }
    } else body = { text: trimmed, teamName: teamName.trim() || undefined, id: !multi && target ? target : undefined };
    setBusy(true);
    try {
      const r = await api.importPost(body);
      if (r.skippedLines) setNote(`${r.skippedLines} line(s) were not recognised as players and were skipped.`);
      setText("");
      onImported(r);
    } catch (e) {
      setErr(toApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed) submit();
      }}
    >
      <h3 className="no-margin">2 · Paste it here</h3>
      <label className="field">
        <span>Paste import JSON or roster text</span>
        <textarea
          className="paste"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={7}
          spellCheck={false}
          placeholder={'{"source":"yahoo-bookmarklet", …}\n\nor roster text, one player per line:\nPatrick Mahomes KC - QB\nJosh Allen (QB - BUF)\n=== Another Team ==='}
        />
      </label>
      {trimmed && !isJson && (
        <div className="row gap wrap">
          {!multi && (
            <label className="field grow">
              <span>Team name</span>
              <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="e.g. Gridiron Gurus" />
            </label>
          )}
          {!multi && (
            <label className="field grow">
              <span>Add to</span>
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">New league</option>
                {imports.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} (adds or replaces this team)
                  </option>
                ))}
              </select>
            </label>
          )}
          {multi && <span className="muted small">Several teams found (=== Name === lines): they will be imported as one new league.</span>}
        </div>
      )}
      <div className="row gap">
        <button className="btn primary" type="submit" disabled={busy || !trimmed}>
          {busy ? "Importing…" : "Import"}
        </button>
        {trimmed && <span className="muted small">{isJson ? "Bookmarklet JSON detected" : "Roster text detected"}</span>}
      </div>
      {note && <div className="notice warn small">{note}</div>}
      {err && <ErrorBox error={err} />}
    </form>
  );
}

function ImportList({
  list,
  loading,
  error,
  reload,
  active,
  onChoose,
}: {
  list?: ImportSummary[];
  loading: boolean;
  error?: ApiError;
  reload: () => void;
  active: Active | null;
  onChoose: Props["onChoose"];
}) {
  const [err, setErr] = useState<ApiError>();
  if (loading && !list) return <Loading label="Loading imported leagues…" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!list?.length) return <p className="muted small no-margin">No imported leagues yet.</p>;
  return (
    <div className="stack-sm">
      <h3 className="no-margin">Imported leagues</h3>
      <ul className="league-list">
        {list.map((l) => {
          const isActive = active?.provider === "import" && active.id === l.id;
          return (
            <li key={l.id} className={isActive ? "active" : ""}>
              <div>
                <div className="strong">{l.name}</div>
                <div className="muted small">
                  {l.teams} of {l.numTeams} teams · imported {ago(l.importedAt)}
                  {l.settingsSource === "default" ? " · default settings" : ""}
                </div>
              </div>
              <div className="row gap">
                <button className={`btn small${isActive ? "" : " primary"}`} disabled={isActive} onClick={() => onChoose({ provider: "import", id: l.id })}>
                  {isActive ? "Active" : "Use"}
                </button>
                <button
                  className="btn small"
                  onClick={async () => {
                    if (!confirm(`Delete "${l.name}" from Trade Desk? (Nothing changes on Yahoo.)`)) return;
                    try {
                      await api.importDelete(l.id);
                      if (isActive) onChoose(null);
                      reload();
                    } catch (e) {
                      setErr(toApiError(e));
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {err && <ErrorBox error={err} />}
    </div>
  );
}

const PRESETS = { std: { label: "Standard", rec: 0 }, half: { label: "Half-PPR", rec: 0.5 }, ppr: { label: "PPR", rec: 1 } } as const;
type PresetId = keyof typeof PRESETS | "custom";
const presetOf = (rec: number): PresetId => (rec === 0 ? "std" : rec === 0.5 ? "half" : rec === 1 ? "ppr" : "custom");
const SLOT_LABEL: Record<string, string> = { FLEX: "W/R/T", WRRB: "W/R", RFLEX: "W/T", SFLEX: "Q/W/R/T" };

/** "QB, WR x2, RB x2, TE, W/R/T, K, DEF, BN x6, IR" */
function slotsToText(slots: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < slots.length; ) {
    let j = i;
    while (j < slots.length && slots[j] === slots[i]) j++;
    const label = SLOT_LABEL[slots[i]] ?? slots[i];
    out.push(j - i > 1 ? `${label} x${j - i}` : label);
    i = j;
  }
  return out.join(", ");
}

function ImportSettings({ id, active, onChoose, onSaved }: { id: string; active: Active; onChoose: Props["onChoose"]; onSaved: () => void }) {
  const stored = useAsync(() => api.importGet(id), [id]);
  if (stored.loading && !stored.data) return <Loading label="Loading league settings…" />;
  if (stored.error) return <ErrorBox error={stored.error} onRetry={stored.reload} />;
  if (!stored.data) return null;
  return <SettingsForm key={stored.data.id + stored.data.importedAt} s={stored.data} active={active} onChoose={onChoose} onSaved={() => (stored.reload(), onSaved())} />;
}

function SettingsForm({ s, active, onChoose, onSaved }: { s: StoredImport; active: Active; onChoose: Props["onChoose"]; onSaved: (n: StoredImport) => void }) {
  const [rec, setRec] = useState(String(s.scoring.rec));
  const [passTd, setPassTd] = useState(String(s.scoring.passTd));
  const [passInt, setPassInt] = useState(String(s.scoring.passInt));
  const [slots, setSlots] = useState(slotsToText(s.slots));
  const [wp, setWp] = useState(s.waiverPriority ? String(s.waiverPriority) : "");
  const [myTeam, setMyTeam] = useState(active.team ?? s.myTeamId ?? s.teams[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError>();
  const [saved, setSaved] = useState(false);
  const preset = presetOf(Number(rec));
  const num = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));

  return (
    <form
      className="stack-sm import-settings"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(undefined);
        setSaved(false);
        const r = num(rec);
        const td = num(passTd);
        const int = num(passInt);
        if (r === undefined || td === undefined || int === undefined) return setErr(new ApiError("Scoring values must be numbers", 400));
        setBusy(true);
        try {
          const n = await api.importSettings(s.id, {
            scoring: { rec: r, passTd: td, passInt: int },
            slots,
            waiverPriority: wp.trim() ? Number(wp) : null,
            myTeamId: myTeam,
          });
          onChoose({ ...active, team: myTeam });
          setSaved(true);
          onSaved(n);
        } catch (e2) {
          setErr(toApiError(e2));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3 className="no-margin">League settings · {s.name}</h3>
      {s.settingsSource === "default" && (
        <div className="notice warn">
          Yahoo's settings page could not be read, so Yahoo's <b>default</b> settings are in use (half-PPR, 1 QB / 2 RB / 2 WR / 1 TE / 1 FLEX).
          Check them against your league's Settings page on Yahoo and fix them below.
        </div>
      )}
      {s.settingsSource === "partial" && <div className="notice warn">Only some settings could be read from Yahoo. Please check them below.</div>}
      <div className="filters">
        <label className="field">
          <span>Scoring preset</span>
          <select
            value={preset}
            onChange={(e) => {
              const p = e.target.value as PresetId;
              if (p !== "custom") setRec(String(PRESETS[p].rec));
            }}
          >
            {Object.entries(PRESETS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
        </label>
        <label className="field">
          <span>Pts per reception</span>
          <input type="text" inputMode="decimal" value={rec} onChange={(e) => setRec(e.target.value)} />
        </label>
        <label className="field">
          <span>Pts per passing TD</span>
          <input type="text" inputMode="decimal" value={passTd} onChange={(e) => setPassTd(e.target.value)} />
        </label>
        <label className="field">
          <span>Pts per interception</span>
          <input type="text" inputMode="decimal" value={passInt} onChange={(e) => setPassInt(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>Roster slots (comma-separated: QB, RB, WR, TE, W/R/T, W/R, W/T, Q/W/R/T, K, DEF, BN, IR; "BN x6" repeats)</span>
        <input type="text" value={slots} onChange={(e) => setSlots(e.target.value)} />
      </label>
      <div className="filters">
        <label className="field">
          <span>My waiver priority</span>
          <input type="text" inputMode="numeric" value={wp} onChange={(e) => setWp(e.target.value)} placeholder="e.g. 5" />
        </label>
        <label className="field grow">
          <span>My team</span>
          <select value={myTeam} onChange={(e) => setMyTeam(e.target.value)}>
            {s.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.players.length} players)
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row gap">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </button>
        {saved && <span className="pos small">Saved. Numbers are recalculated.</span>}
      </div>
      {err && <ErrorBox error={err} />}
    </form>
  );
}
