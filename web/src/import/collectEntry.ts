// Headless entry for the server's auto-import (stopgap until the Yahoo API is approved; docs/DESIGN.md "Auto-import
// (stopgap until Yahoo API)"). Bundled by server/providers/import-bookmarklet.ts (collectorCode) and evaluated in the
// Yahoo league page by server/autoimport/collector.ts; it only exposes collect(): no overlay, no handoff, no auto-run.
import { collect } from "./collect";
import { withMatchups } from "./matchups";

// collect() unchanged, then the matchups (docs/DESIGN.md "Matchups and results log (2026-10-31)"): never throws.
const collectAll = async () => withMatchups(await collect());
(globalThis as unknown as { __ftdCollect?: typeof collectAll }).__ftdCollect = collectAll;
