import { useMemo, useState } from "react";
import { api, type Active, type Analysis, type DetailItem, type ValueRow } from "../api";
import { Empty, ErrorBox, Loading, PosBadge } from "../components/common";
import { ColumnHelp, HelpTip } from "../components/HelpTip";
import { InjuryDot } from "../components/PlayerChip";
import { deltaClass, f1, signed } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { PosFilter } from "./WaiversTab";

type SortKey = "value" | "market" | "marketRank" | "edge" | "ppg" | "luck" | "ppg26" | "ppgExp26" | "posRank" | "ecrOverall" | "name" | "owner";
// One-sentence meanings behind each column's tappable "?" (server/model/projectionV4.ts, labels.ts and market.ts definitions).
const COLS: { key: SortKey; label: string; num: boolean; tip?: string; hideSm?: boolean; market?: boolean }[] = [
  { key: "name", label: "Player", num: false },
  { key: "value", label: "Value", num: true, tip: "Our 0–100 trade value: projected weekly points above replacement, playoff weeks weighted most when you hold a playoff spot." },
  { key: "market", label: "Market", num: true, market: true, tip: "What managers trade him for: FantasyCalc value from real trades (#1 = 100); * = not in their list, our estimate." },
  { key: "marketRank", label: "Mkt rk", num: true, market: true, hideSm: true, tip: "His overall rank in the FantasyCalc market list (— = not listed)." },
  { key: "edge", label: "Edge", num: true, market: true, hideSm: true, tip: "Our value on the market's scale minus his market value: + the market undervalues him, − overvalues him, — when the market has no real value for him or his return is unconfirmed (his trade value is a placeholder then)." },
  { key: "ppg", label: "PPG", num: true, tip: "Projected points per game when he plays, your scoring: his recent usage and finishing, the experts as a check, and his matchups." },
  { key: "luck", label: "Luck", num: true, tip: "Expected minus actual points per game by his usage, recent games weigh most: + = due for more (buy-low at +2), − = above his usage (sell-high at −2 when TDs drive it)." },
  { key: "ppg26", label: "2026", num: true, hideSm: true, tip: "Actual points per game this season in your scoring (— = no games yet)." },
  { key: "ppgExp26", label: "Exp 26", num: true, hideSm: true, tip: "Expected points per game this season from his opportunities (targets, carries, air yards), your scoring." },
  { key: "posRank", label: "Pos rk", num: true, tip: "His rank at his position by projected points per game." },
  { key: "ecrOverall", label: "ECR", num: true, hideSm: true, tip: "FantasyPros expert consensus rest-of-season overall rank (— = unranked)." },
  { key: "owner", label: "Owner", num: false },
];
const PAGE = 100;

export function ValuesTab({ analysis, active }: { analysis: Analysis; active: Active & { team: string } }) {
  const res = useAsync(() => api.values(active), [active.provider, active.id, active.team]);
  const [pos, setPos] = useState("");
  const [q, setQ] = useState("");
  const [availOnly, setAvailOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "value", dir: -1 });
  const [limit, setLimit] = useState(PAGE);
  // A player's value bullets, fetched on the first tap of his "?" (kept out of the list payload).
  const whyCache = useMemo(() => new Map<string, Promise<DetailItem[]>>(), [active.provider, active.id, active.team]); // eslint-disable-line react-hooks/exhaustive-deps
  const whyOf = (id: string) => {
    let p = whyCache.get(id);
    if (!p) {
      p = api.valueWhy(active, id);
      p.catch(() => whyCache.delete(id));
      whyCache.set(id, p);
    }
    return p;
  };
  const teamNames = useMemo(() => new Map(analysis.teams.map((t) => [t.team.id, t.team.name])), [analysis]);

  const owner = (r: ValueRow) => (r.ownerTeamId ? (teamNames.get(r.ownerTeamId) ?? r.ownerTeamId) : "FA");

  const rows = useMemo(() => {
    if (!res.data) return [];
    const needle = q.trim().toLowerCase();
    const filtered = res.data.filter(
      (r) => (!pos || r.pos === pos) && (!availOnly || !r.ownerTeamId) && (!needle || r.name.toLowerCase().includes(needle) || r.team.toLowerCase() === needle),
    );
    // null = unknown (no market edge, no ECR …): always sorted last, whichever direction.
    const get = (r: ValueRow): string | number | null => {
      switch (sort.key) {
        case "name":
          return r.name;
        case "owner":
          return r.ownerTeamId ? owner(r) : "~"; // free agents last
        case "ecrOverall":
          return r.ecrOverall ?? null;
        case "marketRank":
          return r.marketRank ?? null;
        case "market":
          return r.market ?? null;
        case "edge":
          return r.edge ?? null;
        case "luck":
          return r.luck ?? null;
        default:
          return r[sort.key];
      }
    };
    return [...filtered].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x === null || y === null) return x === y ? b.value - a.value : x === null ? 1 : -1;
      const c = typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y)) : x === y ? 0 : x < y ? -1 : 1;
      return c * sort.dir || b.value - a.value;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res.data, pos, q, availOnly, sort, teamNames]);

  const clickSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "name" || key === "owner" || key === "posRank" || key === "ecrOverall" || key === "marketRank" ? 1 : -1 }));

  const hasMarket = analysis.valueSource !== "model" && !!res.data?.some((r) => r.market !== undefined);
  const cols = COLS.filter((c) => !c.market || hasMarket);

  if (res.error) return <ErrorBox error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading label="Valuing every player…" />;

  return (
    <div className="stack">
      <section className="card filters">
        <PosFilter value={pos} onChange={(v) => (setPos(v), setLimit(PAGE))} options={["QB", "RB", "WR", "TE", "K", "DEF"]} />
        <input className="search grow" type="search" placeholder="Search player or NFL team…" value={q} onChange={(e) => (setQ(e.target.value), setLimit(PAGE))} />
        <label className="check">
          <input type="checkbox" checked={availOnly} onChange={(e) => setAvailOnly(e.target.checked)} /> Free agents only
        </label>
      </section>

      {rows.length === 0 ? (
        <Empty>No players match.</Empty>
      ) : (
        <div className="table-wrap card flush">
          <table className="table values">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.key} className={`${c.num ? "num" : ""}${c.hideSm ? " hide-sm" : ""}`} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                    <ColumnHelp tip={c.tip}>
                      <button className={`sort-btn${sort.key === c.key ? " active" : ""}`} onClick={() => clickSort(c.key)}>
                        {c.label}
                        <span className="sort-arrow">{sort.key === c.key ? (sort.dir === 1 ? "▲" : "▼") : ""}</span>
                      </button>
                    </ColumnHelp>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((r) => (
                <tr key={r.id} className={r.ownerTeamId === active.team ? "mine" : ""}>
                  <td>
                    <div className="player-cell">
                      <PosBadge pos={r.pos} />
                      <span className="strong">{r.name}</span>
                      <span className="muted small hide-sm">{r.team}</span>
                      <InjuryDot player={r} />
                      <HelpTip load={() => whyOf(r.id)} label={`How ${r.name} is valued`} />
                    </div>
                  </td>
                  <td className="num strong">{f1(r.value)}</td>
                  {hasMarket && (
                    <>
                      <td className="num">
                        {r.market !== undefined ? f1(r.market) : "—"}
                        {r.marketEstimated ? "*" : ""}
                      </td>
                      <td className="num hide-sm">{r.marketRank ?? "—"}</td>
                      <td className={`num hide-sm delta ${Math.abs(r.edge ?? 0) >= 8 ? deltaClass(r.edge) : "neutral"}`}>{r.edge !== undefined ? signed(r.edge) : "—"}</td>
                    </>
                  )}
                  <td className="num">{f1(r.ppg)}</td>
                  <td className={`num delta ${Math.abs(r.luck ?? 0) >= 2 ? deltaClass(r.luck) : "neutral"}`} title={r.label ?? undefined}>
                    {r.luck !== undefined ? signed(r.luck) : "—"}
                  </td>
                  <td className="num hide-sm">{r.games ? f1(r.ppg26) : "—"}</td>
                  <td className="num hide-sm">{r.games ? f1(r.ppgExp26) : "—"}</td>
                  <td className="num">
                    {r.pos}
                    {r.posRank}
                  </td>
                  <td className="num hide-sm">{r.ecrOverall != null ? String(Math.round(r.ecrOverall * 10) / 10) : "—"}</td>
                  <td className={r.ownerTeamId ? "owner" : "owner fa"}>{owner(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > limit && (
            <div className="table-more">
              <button className="btn" onClick={() => setLimit((l) => l + PAGE)}>
                Show more ({rows.length - limit} left)
              </button>
            </div>
          )}
        </div>
      )}
      {analysis.valueSource === "model" && <div className="notice warn small">Market values (FantasyCalc) are unavailable right now: only our own values are shown.</div>}
      <p className="muted small row gap">
        {rows.length} players
        <HelpTip
          text="Replacement level: projected ppg of the best player you could add for free at each position (Value counts points above it)."
          items={Object.entries(analysis.replacement).map(([k, v]) => ({ label: k, value: `${f1(v)} ppg` }))}
          label="Replacement levels"
        />
      </p>
    </div>
  );
}
