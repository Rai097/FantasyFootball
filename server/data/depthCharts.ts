// NFL depth charts (nflverse, ESPN snapshots). The season file is ~55 MB, so it is
// streamed once and only the latest snapshot's offensive QB/RB/WR/TE rows are kept,
// then cached on disk as a small JSON (.cache/depth-<season>.json).
import fs from "node:fs/promises";
import path from "node:path";
import { sources } from "./sources.js";
import { normTeam } from "./names.js";
import { getNflState } from "./nfl.js";

export type DepthPos = "QB" | "RB" | "WR" | "TE";
const OFFENSE: DepthPos[] = ["QB", "RB", "WR", "TE"];

/** One offensive depth-chart row of the latest snapshot. */
export interface DepthRow {
  id: string; // gsis id
  name: string;
  team: string;
  pos: DepthPos;
  /** Depth within the slot (1 = starter at that slot); WR has three starting slots. */
  rank: number;
  /** Formation slot number (orders WR slots X / Z / slot); 0 when unknown. */
  slot: number;
}

export interface DepthChart {
  season: number;
  /** NFL week the snapshot applies to (the upcoming week for daily snapshots). */
  week: number;
  /** Snapshot timestamp (or "week N"). */
  asOf: string;
  /** Player id → 1-based order among his team's players at his position, plus the raw slot rank. */
  byPlayer: Map<string, { depth: number; week: number; rank: number; team: string; pos: DepthPos }>;
  /** "TEAM|POS" → player ids in depth order. */
  byTeamPos: Map<string, string[]>;
}

/** Split one CSV line (quote-aware; the file has no quotes today). */
function splitLine(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (f += '"'), i++;
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") out.push(f), (f = "");
    else f += c;
  }
  out.push(f);
  return out;
}

/**
 * Incremental reducer over depth-chart CSV lines. Keeps only rows of the newest
 * snapshot (2025+ format, `dt`) or the newest week (≤ 2024 format, `week` + `depth_team`).
 */
export class DepthReducer {
  private header: string[] | null = null;
  private col: Record<string, number> = {};
  private newFormat = true;
  private latest = "";
  private latestWeek = -1;
  rows: DepthRow[] = [];

  push(line: string) {
    if (!line) return;
    const f = splitLine(line);
    if (!this.header) {
      this.header = f;
      f.forEach((h, i) => (this.col[h.trim()] = i));
      this.newFormat = "dt" in this.col;
      return;
    }
    const g = (k: string) => (this.col[k] === undefined ? "" : (f[this.col[k]] ?? "").trim());
    if (this.newFormat) {
      const pos = g("pos_abb") as DepthPos;
      if (!OFFENSE.includes(pos)) return;
      const dt = g("dt");
      if (dt < this.latest) return;
      if (dt > this.latest) {
        this.latest = dt;
        this.rows = [];
      }
      const id = g("gsis_id");
      if (!id || id === "NA") return;
      this.rows.push({ id, name: g("player_name"), team: normTeam(g("team")), pos, rank: Number(g("pos_rank")) || 99, slot: Number(g("pos_slot")) || 0 });
    } else {
      const pos = g("position") as DepthPos;
      if (!OFFENSE.includes(pos)) return;
      if (g("game_type") && g("game_type") !== "REG") return;
      const wk = Number(g("week")) || 0;
      if (wk < this.latestWeek) return;
      if (wk > this.latestWeek) {
        this.latestWeek = wk;
        this.rows = [];
      }
      const id = g("gsis_id");
      if (!id || id === "NA") return;
      this.rows.push({ id, name: g("full_name"), team: normTeam(g("club_code")), pos, rank: Number(g("depth_team")) || 99, slot: 0 });
    }
  }

  /** Snapshot label: the `dt` timestamp, or "week N" for the old format. */
  get asOf(): string {
    return this.newFormat ? this.latest : `week ${this.latestWeek}`;
  }
  get week(): number | undefined {
    return this.newFormat ? undefined : this.latestWeek;
  }
}

/** Build the lookup maps from snapshot rows (order: slot rank, then formation slot). */
export function buildDepthChart(rows: DepthRow[], season: number, week: number, asOf: string): DepthChart {
  const byTeamPos = new Map<string, string[]>();
  const byPlayer: DepthChart["byPlayer"] = new Map();
  const groups = new Map<string, DepthRow[]>();
  for (const r of rows) {
    const k = `${r.team}|${r.pos}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  for (const [k, list] of groups) {
    list.sort((a, b) => a.rank - b.rank || a.slot - b.slot);
    const ids: string[] = [];
    for (const r of list) {
      if (byPlayer.has(r.id)) continue; // a player listed twice keeps his best spot
      ids.push(r.id);
      byPlayer.set(r.id, { depth: ids.length, week, rank: r.rank, team: r.team, pos: r.pos });
    }
    byTeamPos.set(k, ids);
  }
  return { season, week, asOf, byPlayer, byTeamPos };
}

const CACHE_DIR = path.resolve(process.cwd(), ".cache");
const TTL_H = 12;
interface Cached {
  season: number;
  week: number;
  asOf: string;
  rows: DepthRow[];
}

async function download(season: number): Promise<{ rows: DepthRow[]; asOf: string; week?: number }> {
  const res = await fetch(sources.depthCharts(season), { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText} for depth_charts_${season}.csv`);
  const red = new DepthReducer();
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) red.push(l.replace(/\r$/, ""));
  }
  buf += dec.decode();
  if (buf) red.push(buf.replace(/\r$/, ""));
  return { rows: red.rows, asOf: red.asOf, week: red.week };
}

const memo = new Map<number, { at: number; p: Promise<DepthChart | null> }>();

/**
 * Latest depth chart for a season, or null when it cannot be loaded (callers fall back
 * to snap-share order). Memoised for TTL_H hours; a stale disk copy is served on network failure.
 */
export function getDepthChart(season: number): Promise<DepthChart | null> {
  const hit = memo.get(season);
  if (hit && Date.now() - hit.at < TTL_H * 36e5) return hit.p;
  const p = loadDepthChart(season).catch((e) => {
    console.warn(`[depth] unavailable: ${(e as Error).message}`);
    memo.delete(season);
    return null;
  });
  memo.set(season, { at: Date.now(), p });
  return p;
}

async function loadDepthChart(season: number): Promise<DepthChart> {
  const file = path.join(CACHE_DIR, `depth-${season}.json`);
  let stale: Cached | null = null;
  try {
    const st = await fs.stat(file);
    const c = JSON.parse(await fs.readFile(file, "utf8")) as Cached;
    if ((Date.now() - st.mtimeMs) / 36e5 < TTL_H) return buildDepthChart(c.rows, c.season, c.week, c.asOf);
    stale = c;
  } catch {
    /* no cache */
  }
  try {
    const t0 = Date.now();
    const state = await getNflState();
    const d = await download(season);
    if (!d.rows.length) throw new Error("no offensive rows");
    const c: Cached = { season, week: d.week ?? state.currentWeek, asOf: d.asOf, rows: d.rows };
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(file, JSON.stringify(c));
    console.log(`[depth] ${d.rows.length} offensive rows as of ${d.asOf} in ${Date.now() - t0}ms`);
    return buildDepthChart(c.rows, c.season, c.week, c.asOf);
  } catch (e) {
    if (stale) {
      console.warn(`[depth] using stale copy: ${(e as Error).message}`);
      return buildDepthChart(stale.rows, stale.season, stale.week, stale.asOf);
    }
    throw e;
  }
}
