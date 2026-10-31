// The one path every import takes after the user hands over data (pasted JSON/text in the Connect tab, or the
// one-click bookmarklet handoff): POST /api/import, replace this browser's backup, and pick the team to open.
import { api, type Active, type ImportResult } from "../api";
import { removeImportBackup, saveImportBackup } from "../lib/storage";

/** Posts an import (same CSRF/Origin guard as any write) and replaces this league's browser backup. */
export async function postImport(body: unknown, isJson: boolean): Promise<ImportResult> {
  const r = await api.importPost(body);
  // Replace (never merge with) this league's browser backup: the server's merged copy, else the payload.
  removeImportBackup(r.id);
  await api.importGet(r.id).then(saveImportBackup, () => {
    if (isJson) saveImportBackup({ ...(body as object), id: r.id });
  });
  return r;
}

/** The league/team to open after an import: a re-import keeps the team the user picked; a new league its detected team. */
export function activeAfterImport(r: ImportResult, active: Active | null): Active {
  const keep = r.updated && active?.provider === "import" && active.id === r.id && active.team && r.teams.some((t) => t.id === active.team);
  return { provider: "import", id: r.id, team: keep ? active!.team : r.myTeamId ?? r.teams[0]?.id };
}
