# Status and roadmap

## Where things stand

- **v1.0.0** was released on 2026-10-22:
  <https://github.com/3333444n/sketchbook/releases/tag/v1.0.0> (ad-hoc-signed arm64 dmg).
- Shipped: offline Excalidraw editor, real `.excalidraw` files, tabs (MRU budget of 5 mounted
  editors) and multiple windows, frameless window with the traffic lights in the tab strip,
  double-click to rename a tab, crash-recovery journal, PNG/SVG export with embedded scene,
  Mermaid to diagram, Open Recent, Finder file association, light/dark/system theme.
- Automated checks: typecheck, lint, Vitest unit tests and Playwright e2e (offline, documents,
  tabs, rename, export, packaged smoke test) all pass locally. CI runs typecheck, unit tests
  and the build, and packages the dmg on `v*` tags.

### Not verified by automation

These were checked by hand at most, or not at all. Re-check them when touching the related code:

- Traffic-light placement and the tab strip's double-click-to-zoom.
- Menu accelerators firing exactly once (not also in Excalidraw).
- Double-clicking a `.excalidraw` file in Finder (cold start and while running).
- Close/quit prompts on dirty tabs, switching past the 5-editor budget, and recovery after a
  crash (listed in [testing.md](testing.md#manual-checklist-before-a-release)).

## Ideas for next iterations

Not committed to; roughly in order of value.

### Updates

There is no update mechanism today ([building-and-releasing.md](building-and-releasing.md#updates)).
Options:

1. **"Check for Updates…" menu item that opens the Releases page** in the browser via
   `shell.openExternal`. No network from the app; fits the offline rules as they stand.
2. **On-demand version check**: on that menu click only, fetch the latest release from the
   GitHub API, compare with `app.getVersion()`, and offer to open the download page. Never
   runs in the background. This needs an exception to "no update checks" in
   [offline.md](offline.md) and AGENTS.md, a narrow allow-rule in the main-process network
   block, and an ADR. Recommended option.
3. **Real auto-update** (`electron-updater` / Squirrel.Mac). On macOS this requires a
   Developer ID signature, so it depends on the signing item below; also needs a `zip` target
   and a background network call.

### Other

- **Developer ID signing and notarization**, to remove the Gatekeeper step
  ([building-and-releasing.md](building-and-releasing.md#future-developer-id-signing-and-notarization)).
- **Intel / universal builds.**
- **CI coverage:** run `pnpm lint` and the e2e suite in CI (neither runs there yet).
- **More e2e tests** for the gaps listed above (close/quit prompts, eviction, crash recovery).
- **Keep undo history across eviction**, or make the budget configurable (measure first; see
  [performance.md](performance.md)).
