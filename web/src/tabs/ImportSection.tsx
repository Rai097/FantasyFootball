// Connect tab → "Import from Yahoo (browser)": bookmarklet link, paste box
// (bookmarklet JSON or copied roster text), imported-league list, settings editor.
// Guide for users: docs/IMPORT.md (served at /api/docs/import).
import { useCallback, useState } from "react";
import { api, type Active, type ImportResult, type ImportSummary, type SettingsSource, type StoredImport } from "../api";
import { ErrorBox, Loading } from "../components/common";
import { DetailList, Disclosure, ExpandableList, ExpandableRow, type DetailLine } from "../components/ExpandableRow";
import { ApiError } from "../lib/errors";
import { ago, stamp } from "../lib/format";
import { removeImportBackup, saveImportBackup } from "../lib/storage";
import { toApiError, useAsync } from "../lib/useAsync";

interface Props {
  active: Active | null;
  /** Admin view: league settings and Delete are shown (users may only re-import their own league). */
  canManage: boolean;
  onChoose: (a: Active | null) => void;
  /** Called after a successful import / re-import; the app refetches and opens My Team. */
  onImported: (r: ImportResult) => void;
  onSettingsSaved: () => void;
}

export function ImportSection({ active, canManage, onChoose, onImported, onSettingsSaved }: Props) {
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
      <div className="muted small">No Yahoo API needed: a bookmark reads your league pages, you paste the result here.</div>
      <div className="grid-2">
        <BookmarkletCard />
        <PasteCard
          imports={list.data ?? []}
          activeImport={activeImport}
          onImported={(r) => {
            list.reload();
            // Re-import keeps the team the user picked; a new league starts on its detected team.
            const team = r.updated && active?.provider === "import" && active.id === r.id && active.team && r.teams.some((t) => t.id === active.team) ? active.team : r.myTeamId ?? r.teams[0]?.id;
            onChoose({ provider: "import", id: r.id, team });
            onImported(r);
          }}
        />
      </div>
      {activeImport && canManage && <ImportSettings key={activeImport} id={activeImport} active={active!} onChoose={onChoose} onSaved={() => (list.reload(), onSettingsSaved())} />}
      <ImportList list={list.data} loading={list.loading} error={list.error} reload={list.reload} active={active} onChoose={onChoose} canManage={canManage} />
    </section>
  );
}

function BookmarkletCard() {
  const bm = useAsync(() => api.bookmarkletUrl(), []);
  const url = bm.data?.url;
  // Set the javascript: href imperatively (React warns about javascript: URLs in JSX) on EVERY mount of the link:
  // a link without href is plain text, so dragging it only selects the words instead of making a bookmark.
  const ref = useCallback(
    (el: HTMLAnchorElement | null) => {
      if (el && url) el.setAttribute("href", url);
    },
    [url],
  );
  return (
    <div className="stack-sm">
      <h3 className="no-margin">1 · Get the data from Yahoo</h3>
      <div className="row gap wrap">
        {bm.data ? (
          <a ref={ref} draggable className="btn primary bookmarklet" onClick={(e) => (e.preventDefault(), alert("Drag this button to your bookmarks bar, then click it while on your Yahoo league page."))}>
            Trade Desk import v2
          </a>
        ) : bm.loading ? (
          <span className="muted">loading…</span>
        ) : null}
        <span className="muted small">
          Drag it to your bookmarks bar (desktop browser).{bm.data?.version ? ` Build ${bm.data.version}.` : ""}
        </span>
      </div>
      {bm.error && <ErrorBox error={bm.error} onRetry={bm.reload} />}
      <Disclosure title="How to use it (4 steps)">
        <ol className="steps">
          <li>Drag the button above to your bookmarks bar.</li>
          <li>
            Open your league on <b>football.fantasysports.yahoo.com</b> (address contains <code>/f1/</code>).
          </li>
          <li>Click the bookmark and wait 10–30 s for the box.</li>
          <li>
            Click <b>Copy to clipboard</b>, then paste in step 2.
          </li>
        </ol>
        <div className="muted small">On a phone: paste roster text instead.</div>
      </Disclosure>
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
      // Replace (never merge with) this league's browser backup: the server's merged copy, else the payload.
      removeImportBackup(r.id);
      await api.importGet(r.id).then(saveImportBackup, () => {
        if (isJson) saveImportBackup({ ...(body as object), id: r.id });
      });
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
      <div className="muted small">Same league again = rosters updated, settings kept.</div>
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
  canManage,
}: {
  canManage: boolean;
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
      <ExpandableList label="Imported leagues" className="import-list">
        {list.map((l) => {
          const isActive = active?.provider === "import" && active.id === l.id;
          return (
            <ExpandableRow
              key={l.id}
              label={l.name}
              className={`import-row${isActive ? " active" : ""}`}
              head={
                <>
                  <div className="imp-main">
                    <div className="strong imp-name">{l.name}</div>
                    <div className="imp-chips">
                      <CapturedChip ok={l.hasStandings} label="Standings" />
                      <CapturedChip ok={l.hasFreeAgents} label="Free agents" />
                      <span className="tag">
                        Updated {stamp(l.importedAt)} by {l.importedBy ?? "—"}
                      </span>
                    </div>
                  </div>
                  <div className="row gap imp-actions" onClick={(e) => e.stopPropagation()}>
                    <button className={`btn small${isActive ? "" : " primary"}`} disabled={isActive} onClick={() => onChoose({ provider: "import", id: l.id })}>
                      {isActive ? "Active" : "Use"}
                    </button>
                    {canManage && (
                      <button
                        className="btn small"
                        onClick={async () => {
                          if (!confirm(`Delete "${l.name}" from Trade Desk? (Nothing changes on Yahoo.)`)) return;
                          try {
                            await api.importDelete(l.id);
                            removeImportBackup(l.id);
                            if (isActive) onChoose(null);
                            reload();
                          } catch (e) {
                            setErr(toApiError(e));
                          }
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </>
              }
            >
              <ImportDetails l={l} />
            </ExpandableRow>
          );
        })}
      </ExpandableList>
      {err && <ErrorBox error={err} />}
    </div>
  );
}

const SOURCE_LABEL: Record<SettingsSource, string> = { page: "read from Yahoo", partial: "partly read from Yahoo", default: "Yahoo defaults (check them)", user: "edited by hand" };

function CapturedChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`tag ${ok ? "tag-good" : "tag-warn"}`} title={ok ? `${label} were captured by the last import.` : `${label} were not captured: re-import with the latest bookmark.`}>
      {label}: {ok ? "yes" : "no"}
    </span>
  );
}

/** Details of one imported league (opened on tap): label/value lines plus the roster moves since the previous import. */
function ImportDetails({ l }: { l: ImportSummary }) {
  const ch = useAsync(() => api.importChanges(l.id), [l.id, l.importedAt]);
  const c = ch.data;
  const items: DetailLine[] = [
    { label: "Teams", value: `${l.teams} of ${l.numTeams}` },
    { label: "Updated", value: `${stamp(l.importedAt)} (${ago(l.importedAt)})` },
    { label: "By", value: l.importedBy ?? "—" },
    { label: "Standings", value: l.hasStandings ? "captured" : "not captured", tone: l.hasStandings ? undefined : "warn" },
    { label: "Free agents", value: l.hasFreeAgents ? "captured" : "not captured", tone: l.hasFreeAgents ? undefined : "warn" },
    { label: "Settings", value: SOURCE_LABEL[l.settingsSource], tone: l.settingsSource === "default" ? "warn" : undefined },
  ];
  if (c?.from) items.push({ label: "Roster moves", value: `${c.playersChanged} since ${stamp(c.from)}` });
  return (
    <>
      <DetailList items={items} />
      {c && c.teams.length > 0 && (
        <ul className="roster-changes">
          {c.teams.map((t) => (
            <li key={t.id}>
              <b>{t.name}</b>
              {t.added.length > 0 && <span className="pos"> + {t.added.join(", ")}</span>}
              {t.dropped.length > 0 && <span className="neg"> − {t.dropped.join(", ")}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
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
          saveImportBackup(n);
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
