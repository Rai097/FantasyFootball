import type { VP } from "../api";
import { f1 } from "../lib/format";
import { PosBadge } from "./common";

function injuryLevel(status?: string): string | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (/^(out|o|ir|pup|susp|na|doubtful|d)$/.test(s) || s.startsWith("out") || s.startsWith("ir")) return "bad";
  return "warn";
}

export function InjuryDot({ player }: { player: Pick<VP, "injury"> }) {
  const lvl = injuryLevel(player.injury?.status);
  if (!lvl || !player.injury) return null;
  const label = `${player.injury.status}${player.injury.detail ? ` – ${player.injury.detail}` : ""}`;
  return <span className={`inj-dot ${lvl}`} title={label} aria-label={label} />;
}

export function PlayerChip({ player, showValue = true, compact = false }: { player: VP | null | undefined; showValue?: boolean; compact?: boolean }) {
  if (!player) return <span className="chip empty-chip">Empty</span>;
  return (
    <span className={`chip${compact ? " compact" : ""}`} title={player.why}>
      <PosBadge pos={player.pos} />
      <span className="chip-name">{player.name}</span>
      <span className="chip-team">{player.team}</span>
      <InjuryDot player={player} />
      {showValue && <span className="chip-value">{f1(player.value)}</span>}
    </span>
  );
}
