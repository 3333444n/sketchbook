# Testing

| Layer      | Tool                   | Command          | Location                                                                 |
| ---------- | ---------------------- | ---------------- | ------------------------------------------------------------------------ |
| Types      | TypeScript             | `pnpm typecheck` | `tsconfig.node.json`, `tsconfig.web.json`                                |
| Unit       | Vitest (node env)      | `pnpm test`      | `src/**/__tests__/**/*.test.ts`                                          |
| End-to-end | Playwright `_electron` | `pnpm test:e2e`  | `tests/e2e/*.spec.ts`, [`playwright.config.ts`](../playwright.config.ts) |

## Unit tests

- Config: [`vitest.config.ts`](../vitest.config.ts). Environment is plain Node.
- Current suites: [`src/main/__tests__/fileio.test.ts`](../src/main/__tests__/fileio.test.ts)
  (atomic writes, extensions, titles, file-name sanitising),
  [`src/main/__tests__/recovery.test.ts`](../src/main/__tests__/recovery.test.ts) (journal
  write, delete, scan, corrupt handling) and
  [`src/main/__tests__/registry.test.ts`](../src/main/__tests__/registry.test.ts) (docs per
  window, active doc, reusable pristine tab, window chrome).
- Tested modules must not import `electron`. Put pure logic in modules like
  `src/main/fileio.ts` and `src/main/recovery.ts`, and keep Electron glue thin.
- Use a temp directory (`fs.mkdtemp(os.tmpdir())`) per test; clean up afterwards.

## End-to-end tests

E2E tests launch the **production build** (`out/main/index.js`) with Playwright's
`_electron.launch`, so they cover the `app://` protocol, CSP and bundled fonts.
[`tests/e2e/fixtures.ts`](../tests/e2e/fixtures.ts) has the shared helpers:

- **`launchApp()`** starts the app with a temp `--user-data-dir` (so journals, the library and
  theme don't leak between runs), records every request seen by the page and by the main
  session, collects CSP violations, and on `close()` answers any "save changes?" prompt with
  Don't Save.
- **Dialogs are stubbed** in the main process through `app.evaluate`, for example replacing
  `dialog.showSaveDialog` / `dialog.showSaveDialogSync` (used by `downloads.ts`) with functions
  that return a temp path.
- `nonLocal(urls)` lists anything that isn't `app:`, `data:`, `blob:`, `devtools:` or a bundled
  `file:` read.

| Spec               | Covers                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offline.spec.ts`  | Served from `app://bundle/` with `boot.js` applied; every font, Mermaid and PNG/SVG export with no network and no CSP violation; main blocks remote requests; `app://` refuses path traversal.                                    |
| `document.spec.ts` | Save, then reopen from argv round-trips the drawing; files from argv open as tabs and closing one leaves the other; double-click renaming of saved (file renamed on disk, taken names refused, Escape cancels) and untitled tabs. |
| `export.spec.ts`   | PNG export goes through the native Save dialog and writes a valid PNG.                                                                                                                                                            |
| `packaged.spec.ts` | Smoke test of `dist/mac-arm64/Sketchbook.app` (skipped unless `pnpm build:mac` has run).                                                                                                                                          |

`pnpm test:e2e` runs `electron-vite build` first. Set `SB_E2E_DEBUG=1` to echo renderer
console output.

Not covered yet: the close/quit prompts on dirty tabs, switching past the 5-editor budget, and
recovery after a crash. Check those by hand (below).

The same `_electron` approach drives [`scripts/screenshots.mjs`](../scripts/screenshots.mjs)
(`pnpm screenshots`), which regenerates the README images.

## What CI runs

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) on `macos-latest`: install with a
frozen lockfile, `pnpm typecheck`, `pnpm test`, `pnpm exec electron-vite build`; on `v*` tags
also builds the dmg. E2E is not in CI yet; run it locally for changes that touch files,
windows, tabs or offline behaviour.

## Manual checklist (before a release)

With Wi-Fi off, on the packaged app:

1. Draw shapes and text; the hand-drawn font renders.
2. ⌘S saves; double-clicking the file in Finder opens it; Open Recent lists it.
3. Export PNG and SVG; reopen the PNG with the embedded scene.
4. Mermaid converts a flowchart.
5. Several tabs and two windows work at once.
6. `kill -9` the app and relaunch: unsaved changes come back as dirty tabs.
7. Closing a dirty tab, a dirty window, and quitting each show the save prompt.
8. Double-click a saved tab's name, rename it, and check the file in Finder has the new name.
9. Install over the previous version (drag to Applications, Replace) and check drawings and
   settings survive.
