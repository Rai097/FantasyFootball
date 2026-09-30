import { useMemo, useState } from "react";
import { api, type Active, type Analysis, type ValueRow } from "../api";
import { Empty, ErrorBox, Loading, PosBadge, Why } from "../components/common";
import { InjuryDot } from "../components/PlayerChip";
import { deltaClass, f1, signed } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { PosFilter } from "./WaiversTab";

type SortKey = "value" | "market" | "marketRank" | "edge" | "ppg" | "ppg26" | "ppgExp26" | "posRank" | "ecrOverall" | "name" | "owner";
const COLS: { key: SortKey; label: string; num: boolean; title?: string; hideSm?: boolean; market?: boolean }[] = [
  { key: "name", label: "Player", num: false },
  { key: "value", label: "Value", num: true, title: "Our (true) 0–100 rest-of-season trade value (points above replacement × games left)" },
  { key: "market", label: "Market", num: true, market: true, title: "Market value, 0–100 (FantasyCalc, from real trades; #1 = 100). * = not in the market list, our estimate" },
  { key: "marketRank", label: "Mkt rk", num: true, market: true, hideSm: true, title: "Market overall rank (FantasyCalc)" },
  { key: "edge", label: "Edge", num: true, market: true, hideSm: true, title: "Our value on the market scale minus market value: + the market undervalues him (buy low), − overvalues him (sell high)" },
  { key: "ppg", label: "PPG", num: true, title: "Projected points per game rest of season, your scoring" },
  { key: "ppg26", label: "2026", num: true, title: "Actual ppg this season", hideSm: true },
  { key: "ppgExp26", label: "Exp 26", num: true, title: "Expected (opportunity-based) ppg this season", hideSm: true },
  { key: "posRank", label: "Pos rk", num: true },
  { key: "ecrOverall", label: "ECR", num: true, title: "FantasyPros rest-of-season consensus overall rank", hideSm: true },
  { key: "owner", label: "Owner", num: false },
];
const PAGE = 150;

export function ValuesTab({ analysis, active }: { analysis: Analysis; active: Active & { team: string } }) {
  const res = useAsync(() => api.values(active), [active.provider, active.id, active.team]);
  const [pos, setPos] = useState("");
  const [q, setQ] = useState("");
  const [availOnly, setAvailOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "value", dir: -1 });
  const [limit, setLimit] = useState(PAGE);
  const teamNames = useMemo(() => new Map(analysis.teams.map((t) => [t.team.id, t.team.name])), [analysis]);

  const owner = (r: ValueRow) => (r.ownerTeamId ? (teamNames.get(r.ownerTeamId) ?? r.ownerTeamId) : "FA");

  const rows = useMemo(() => {
    if (!res.data) return [];
    const needle = q.trim().toLowerCase();
    const filtered = res.data.filter(
      (r) => (!pos || r.pos === pos) && (!availOnly || !r.ownerTeamId) && (!needle || r.name.toLowerCase().includes(needle) || r.team.toLowerCase() === needle),
    );
    const get = (r: ValueRow): string | number => {
      switch (sort.key) {
        case "name":
          return r.name;
        case "owner":
          return r.ownerTeamId ? owner(r) : "~"; // free agents last
        case "ecrOverall":
          return r.ecrOverall ?? Number.POSITIVE_INFINITY;
        case "marketRank":
          return r.marketRank ?? Number.POSITIVE_INFINITY;
        case "market":
          return r.market ?? -1;
        case "edge":
          return r.edge ?? 0;
        default:
          return r[sort.key];
      }
    };
    return [...filtered].sort((a, b) => {
      const x = get(a);
      const y = get(b);
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
                  <th key={c.key} className={`${c.num ? "num" : ""}${c.hideSm ? " hide-sm" : ""}`} title={c.title} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                    <button className={`sort-btn${sort.key === c.key ? " active" : ""}`} onClick={() => clickSort(c.key)}>
                      {c.label}
                      <span className="sort-arrow">{sort.key === c.key ? (sort.dir === 1 ? "▲" : "▼") : ""}</span>
                    </button>
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
                      <Why text={r.why} />
                    </div>
                  </td>
                  <td className="num strong">{f1(r.value)}</td>
                  {hasMarket && (
                    <>
                      <td className="num">
                        {r.market !== undefined ? f1(r.market) : "–"}
                        {r.marketEstimated ? "*" : ""}
                      </td>
                      <td className="num hide-sm">{r.marketRank ?? "–"}</td>
                      <td className={`num hide-sm delta ${Math.abs(r.edge ?? 0) >= 8 ? deltaClass(r.edge) : "neutral"}`}>{r.edge !== undefined ? signed(r.edge) : "–"}</td>
                    </>
                  )}
                  <td className="num">{f1(r.ppg)}</td>
                  <td className="num hide-sm">{r.games ? f1(r.ppg26) : "–"}</td>
                  <td className="num hide-sm">{r.games ? f1(r.ppgExp26) : "–"}</td>
                  <td className="num">
                    {r.pos}
                    {r.posRank}
                  </td>
                  <td className="num hide-sm">{r.ecrOverall != null ? String(Math.round(r.ecrOverall * 10) / 10) : "–"}</td>
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
      <p className="muted small">
        {rows.length} players · replacement ppg:{" "}
        {Object.entries(analysis.replacement)
          .map(([k, v]) => `${k} ${f1(v)}`)
          .join(" · ")}
      </p>
    </div>
  );
}
