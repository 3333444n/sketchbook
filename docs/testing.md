# Testing

| Layer | Tool | Command | Location |
|---|---|---|---|
| Types | TypeScript | `pnpm typecheck` | `tsconfig.node.json`, `tsconfig.web.json` |
| Unit | Vitest (node env) | `pnpm test` | `src/**/__tests__/**/*.test.ts` |
| End-to-end | Playwright `_electron` | `pnpm test:e2e` (planned) | `tests/e2e/*.spec.ts`, `playwright.config.ts` (planned) |

## Unit tests

- Config: [`vitest.config.ts`](../vitest.config.ts). Environment is plain Node.
- Current suites: [`src/main/__tests__/fileio.test.ts`](../src/main/__tests__/fileio.test.ts)
  (atomic writes, extensions) and
  [`src/main/__tests__/recovery.test.ts`](../src/main/__tests__/recovery.test.ts) (journal
  write, delete, scan, corrupt handling).
- Tested modules must not import `electron`. Put pure logic in modules like
  `src/main/fileio.ts` and `src/main/recovery.ts`, and keep Electron glue thin.
- Use a temp directory (`fs.mkdtemp(os.tmpdir())`) per test; clean up afterwards.

## End-to-end tests (planned)

E2E tests launch the **production build** with Playwright's `_electron.launch`, so they cover
the `app://` protocol, CSP and bundled fonts.

- **Network blocked:** any request that isn't `app:`, `data:` or `blob:` fails the test.
- **Dialogs are stubbed** in the main process through `electronApp.evaluate`, for example
  replacing `dialog.showSaveDialog` / `dialog.showOpenDialog` /
  `dialog.showSaveDialogSync` (used by `downloads.ts`) with functions that return a temp path.
- **Isolated profile:** pass a temp `--user-data-dir` so recovery journals and the library don't
  leak between runs.

Coverage targets:

1. Canvas renders offline; `document.fonts.check('20px Excalifont')` is true after drawing text.
2. Save and reopen round-trip of a `.excalidraw` file.
3. PNG export through `will-download` writes a valid PNG.
4. Tabs: ⌘T, ⌘W on a dirty tab (prompt), switching past the 5-editor budget and back
   (evicted tab restores its scene).
5. Recovery: write a journal, relaunch, the doc comes back as a dirty tab.

Typical run:

```bash
pnpm exec electron-vite build
pnpm test:e2e
```

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
