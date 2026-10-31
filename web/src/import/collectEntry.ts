// Headless entry for the server's auto-import (stopgap until the Yahoo API is approved; docs/DESIGN.md "Auto-import
// (stopgap until Yahoo API)"). Bundled by server/providers/import-bookmarklet.ts (collectorCode) and evaluated in the
// Yahoo league page by server/autoimport/collector.ts; it only exposes collect(): no overlay, no handoff, no auto-run.
import { collect } from "./collect";

(globalThis as unknown as { __ftdCollect?: typeof collect }).__ftdCollect = collect;
