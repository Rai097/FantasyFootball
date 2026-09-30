const TEAM_ALIASES: Record<string, string> = {
  LA: "LAR", LVR: "LV", OAK: "LV", JAC: "JAX", WSH: "WAS", GNB: "GB", KAN: "KC", NWE: "NE", NOR: "NO",
  SFO: "SF", TAM: "TB", SD: "LAC", SDG: "LAC", STL: "LAR", HST: "HOU", BLT: "BAL", CLV: "CLE", ARZ: "ARI",
  // Yahoo / other four-letter and legacy spellings
  BUFF: "BUF", JACK: "JAX", WASH: "WAS", PITT: "PIT", CINC: "CIN", CLEV: "CLE", DENV: "DEN", DETR: "DET",
  HOUS: "HOU", INDY: "IND", MINN: "MIN", SEAT: "SEA", TENN: "TEN", DALL: "DAL", BALT: "BAL", CHIC: "CHI",
  MIAM: "MIA", ATLA: "ATL", CARO: "CAR", PHIL: "PHI", ARIZ: "ARI", LARM: "LAR", LACH: "LAC",
  "": "FA", NA: "FA",
};

/** Map a defense nickname or city ("Bills", "Buffalo", "Buffalo Bills") to its abbreviation. */
export function teamFromDefenseName(name: string): string | undefined {
  const n = name.toLowerCase().replace(/[^a-z ]/g, "").replace(/\b(d\/?st|defense|def)\b/g, "").trim();
  if (!n) return undefined;
  for (const [abbr, full] of Object.entries(NFL_TEAM_NAMES)) {
    const f = full.toLowerCase();
    if (f === n || f.endsWith(" " + n) || f.startsWith(n + " ") || n === f.split(" ").pop()) return abbr;
  }
  return undefined;
}

export function normTeam(t: string | undefined): string {
  const u = (t ?? "").toUpperCase().trim();
  return TEAM_ALIASES[u] ?? (u || "FA");
}

export function normName(n: string): string {
  return n
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z]/g, "");
}

export function normPos(p: string | undefined): string {
  const u = (p ?? "").toUpperCase();
  if (u === "PK") return "K";
  if (u === "DST" || u === "D/ST" || u === "D") return "DEF";
  return u;
}

export const NFL_TEAM_NAMES: Record<string, string> = {
  ARI: "Arizona Cardinals", ATL: "Atlanta Falcons", BAL: "Baltimore Ravens", BUF: "Buffalo Bills",
  CAR: "Carolina Panthers", CHI: "Chicago Bears", CIN: "Cincinnati Bengals", CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys", DEN: "Denver Broncos", DET: "Detroit Lions", GB: "Green Bay Packers",
  HOU: "Houston Texans", IND: "Indianapolis Colts", JAX: "Jacksonville Jaguars", KC: "Kansas City Chiefs",
  LAC: "Los Angeles Chargers", LAR: "Los Angeles Rams", LV: "Las Vegas Raiders", MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings", NE: "New England Patriots", NO: "New Orleans Saints", NYG: "New York Giants",
  NYJ: "New York Jets", PHI: "Philadelphia Eagles", PIT: "Pittsburgh Steelers", SEA: "Seattle Seahawks",
  SF: "San Francisco 49ers", TB: "Tampa Bay Buccaneers", TEN: "Tennessee Titans", WAS: "Washington Commanders",
};
