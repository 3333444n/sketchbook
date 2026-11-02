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
- Agent bridge suites:
  [`settings.test.ts`](../src/main/__tests__/settings.test.ts) (defaults for a missing or
  corrupt file, round-trip, unknown keys dropped),
  [`agentServer.test.ts`](../src/main/__tests__/agentServer.test.ts) (a real Unix socket in a
  temp dir with a fake host: `0700` dir and `0600` socket, pointer shape, every method,
  `UNKNOWN_METHOD`, garbage lines answered with `id: null`, `BAD_PARAMS` and limits, host
  error passthrough, `TOO_LARGE` closes the connection, concurrent requests, stale-socket
  replacement, refusing a live socket, the tmpdir path fallback, `stop()` cleanup),
  [`agentConfig.test.ts`](../src/main/__tests__/agentConfig.test.ts) (JSON snippet and the
  shell-quoted `claude mcp add` one-liner),
  [`src/renderer/src/__tests__/agentScene.test.ts`](../src/renderer/src/__tests__/agentScene.test.ts)
  (summaries, bounds with rotation, delete planning, patch validation, skeleton validation,
  arrow routing and bindings),
  [`src/mcp/__tests__/server.test.ts`](../src/mcp/__tests__/server.test.ts) (the MCP server
  over an in-memory transport with the SDK client: 8 tools listed, arguments forwarded to the
  rpc, `get_image` returns image content, `AgentError` → `isError`, zod rejects bad input)
  and [`src/mcp/__tests__/client.test.ts`](../src/mcp/__tests__/client.test.ts)
  (`SKETCHBOOK_USER_DATA`, `DISABLED` vs `NOT_RUNNING`, dead pid, an inline NDJSON echo server
  for the socket RPC, timeout and stale-socket mapping).
- Tested modules must not import `electron`. Put pure logic in modules like
  `src/main/fileio.ts`, `src/main/recovery.ts`, `src/main/agentServer.ts` and
  `src/renderer/src/agentScene.ts` (type-only imports from Excalidraw), and keep Electron
  glue thin. `src/mcp/` never imports `electron` at all.
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

| Spec               | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `offline.spec.ts`  | Served from `app://bundle/` with `boot.js` applied; every font, Mermaid and PNG/SVG export with no network and no CSP violation; main blocks remote requests; `app://` refuses path traversal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `document.spec.ts` | Save, then reopen from argv round-trips the drawing; files from argv open as tabs and closing one leaves the other; double-click renaming of saved (file renamed on disk, taken names refused, Escape cancels) and untitled tabs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `export.spec.ts`   | PNG export goes through the native Save dialog and writes a valid PNG.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `agent.spec.ts`    | Seven tests against an isolated profile (`makeAgentProfile()`), using the real socket client from `src/mcp/client.ts` (`createSocketRpc({ userData })`): (1) full round trip: a pre-written `settings.json` turns the bridge on, the pointer has the right shape, socket `0600` and dirs `0700`; `listTabs`; `addElements` with a labelled rectangle, text, an auto-routed arrow (no x/y) and one with explicit points makes the tab dirty and `getScene` shows labels and bindings; `updateElements`; `exportImage`; `deleteElements` unbinds the arrow's start; `newDrawing` then an immediate `addElements` on the new tab; an omitted `docId` targets the active tab; `NO_SUCH_DOC` and `BAD_PARAMS` cases; no non-local requests. (2) Undo: one ⌘Z removes a whole `addElements` call, ⌘⇧Z restores it. (3) Eviction: with 7 tabs, an op on the first `docId` remounts and activates it. (4) The MCP server over stdio: `node out/main/mcp.js` through `StdioClientTransport` with `SKETCHBOOK_USER_DATA`; `list_drawings`, `add_elements`, `get_image` returns image content, `get_scene` error mapping. (5) Off by default and the menu toggle (`toggleAgentMenu`, item id `allow-agent-connections`); the client reports `DISABLED` while off. (6) The in-app main menu (`agent-toggle`, `agent-setup` test ids): turning the bridge on there writes the pointer and `settings.json` and checks the native item; turning it off via the native menu unchecks the in-app item (`aria-checked`, `dropdown-menu-item--selected`); "Set up agent access…" shows the native dialog. (7) The setting survives quit and relaunch; the pointer is removed on quit. |
| `packaged.spec.ts` | Smoke tests of `dist/mac-arm64/Sketchbook.app` (both skipped unless `pnpm build:mac` has run): starts offline with bundled fonts; and `Contents/Resources/mcp/index.js` ships, spawns with `ELECTRON_RUN_AS_NODE=1`, lists 8 tools, and `list_drawings` against a scratch profile answers `DISABLED: …`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

`pnpm test:e2e` runs `electron-vite build` first. Set `SB_E2E_DEBUG=1` to echo renderer
console output.

17 e2e tests in all; the 2 packaged ones need `pnpm build:mac`. Agent fixture helpers in
`fixtures.ts`: `makeAgentProfile()`, `waitForPointer` / `waitForNoPointer`, `readPointer`,
`readSettings`, `toggleAgentMenu(app)`. The agent spec reads the pointer from the test's
`--user-data-dir` (passed as `userData` to the client), never from
`~/Library/Application Support`. Gotcha when testing undo: clicking an element before ⌘Z adds
a selection step to Excalidraw 0.18's history, so focus the empty canvas first.

Not covered yet: the close/quit prompts on dirty tabs, switching past the 5-editor budget
(apart from the agent case above), recovery after a crash, and a session with a real MCP
client such as Claude Code. Check those by hand (below).

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
10. Agent bridge: turn on Agent ▸ Allow Agent Connections, register the server with Claude
    Code (Agent ▸ Set Up Agent Access…), ask for a diagram. Check: the drawing appears in the
    active tab, `get_image` shows it, one ⌘Z undoes one call, the tab is dirty and ⌘S saves
    it, turning the bridge off makes the next call fail with `DISABLED`, and the setting is
    still on after a relaunch. Everything with Wi-Fi off.
