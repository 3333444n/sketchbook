# AGENTS.md

Guidance for AI coding agents working on Sketchbook. Humans: see [COLLABORATING.md](COLLABORATING.md).

## What this is

Sketchbook is an offline macOS (Apple Silicon) desktop whiteboard. It is an Electron app that
embeds the MIT-licensed [`@excalidraw/excalidraw`](https://github.com/excalidraw/excalidraw)
component (0.18.1) as an npm dependency. We do not fork excalidraw-app; the pieces that only
exist there (persistence, welcome screen, main menu) are rebuilt here. Collaboration, share
links, AI and online library browsing are out of scope.

Stack: Electron 44.9.3, electron-vite 6, React 19, TypeScript, pnpm, Node 24,
electron-builder 26 (ad-hoc-signed arm64 dmg), Vitest, Playwright `_electron`.

## Repo map

| Path | What |
|---|---|
| `src/shared/ipc.ts` | **The IPC contract (v2: tabs).** Types plus channel names. Every layer codes against it. |
| `src/preload/index.ts` | Implements `SketchbookAPI` on `window.sketchbook` via `contextBridge`. |
| `src/main/index.ts` | Thin bootstrap: scheme registration, `initDocuments()`, `buildMenu()`. |
| `src/main/protocol.ts` | `app://bundle/` scheme and renderer loading. |
| `src/main/documents.ts` | Windows, document registry, open/save, close/quit prompts, IPC handlers, link policy. |
| `src/main/fileio.ts` | Pure file helpers: `atomicWrite`, extensions, `readDocContents`. No `electron` import. |
| `src/main/recovery.ts` | Crash-recovery journal in `userData/recovery/`. No `electron` import. |
| `src/main/finder.ts` | Single-instance lock, `open-file`, argv paths. |
| `src/main/downloads.ts` | `will-download` → native Save dialog (image export, library export). |
| `src/main/menu.ts` | Native application menu and accelerators. |
| `src/main/__tests__/` | Vitest unit tests (node environment). |
| `src/renderer/index.html` | Renderer entry; **the CSP meta tag lives here**. |
| `src/renderer/src/App.tsx` | Window shell: tabs, theme, library, shared shortcuts. |
| `src/renderer/src/DocumentEditor.tsx` | One drawing: an `<Excalidraw>` instance plus its lifecycle. |
| `src/renderer/src/useDocument.ts` | Per-document state: load, dirty/empty, debounced autosave, save. |
| `src/renderer/src/bridge.ts` | Thin adapter over `window.sketchbook`. |
| `src/renderer/src/shortcuts.ts` | Capture-phase key handler that yields menu-owned keys to the native menu. |
| `src/renderer/src/components/` | `AppMainMenu`, `AppWelcomeScreen`, icons. |
| `electron.vite.config.ts`, `electron-builder.yml` | Build and packaging. |
| `docs/` | Architecture, IPC reference, offline, performance, testing, release, [ADRs](docs/adr/README.md). |

Planned (being added in parallel, may not exist yet): `boot.js` pre-bundle script,
`playwright.config.ts` and `tests/e2e/`, the `test:e2e` script, the tab-strip component.

## Commands

```bash
pnpm i             # install (also installs Electron and app deps)
pnpm dev           # run with hot reload
pnpm typecheck     # tsc for node (main/preload/shared) and web (renderer)
pnpm test          # Vitest unit tests
pnpm test:e2e      # Playwright _electron e2e against the production build (planned)
pnpm build:mac     # typecheck + build + arm64 dmg in dist/
```

## Architecture in brief

Three layers, and they talk **only** through `src/shared/ipc.ts`:

```
main (Node, privileged)  <── ipc.ts channels ──>  preload (sandboxed)  <── window.sketchbook ──>  renderer (React + Excalidraw)
```

- **Main** is the source of truth for documents: which window holds which `docId`, each doc's
  path and dirty state. It owns dialogs, disk, the recovery journal, menus and window chrome.
- **Renderer** owns tab order, the active tab and all UI. It reports the active tab with
  `setActiveDoc`. All tabs in a window share one renderer process.
- **Preload** is a pass-through. It contains no logic.

Details: [docs/architecture.md](docs/architecture.md), [docs/ipc-contract.md](docs/ipc-contract.md).

## Rules

1. **Never add network calls.** No remote URLs, CDNs, telemetry, update checks or font
   fetches. The app must work with Wi-Fi off. See [docs/offline.md](docs/offline.md).
2. **Never write to a renderer-supplied path.** Main writes only to paths it got from its own
   dialog or already tracks for that doc. The renderer sends contents and a `docId`, never a path.
3. **Contract first.** To change IPC, edit `src/shared/ipc.ts` first, then update preload, main
   and renderer in the same change. Keep [docs/ipc-contract.md](docs/ipc-contract.md) in sync.
4. **Validate every IPC message in main**: look up the sender's window, check the `docId`
   belongs to that window, and type-check arguments.
5. **Per-document state stays inside `DocumentEditor` / `useDocument`.** No module-level
   singletons for scene, dirty or path state; several editors coexist.
6. **Mind the editor budget.** At most 5 Excalidraw editors are mounted per window (MRU).
   Don't add work that runs in every mounted editor on every change. See
   [docs/performance.md](docs/performance.md).
7. **Architectural changes need an ADR** in [docs/adr/](docs/adr/README.md).
8. Keep the security defaults: `contextIsolation: true`, `sandbox: true`,
   `nodeIntegration: false`, navigation blocked, external links only via `shell.openExternal`
   for `http:`, `https:` and `mailto:`.
9. Product name is "Sketchbook". Don't use the Excalidraw name or logo as branding; keep the
   "Built with Excalidraw (MIT)" credit.

## Gotchas

- **`window.EXCALIDRAW_ASSET_PATH` must be set before the bundle loads.** That's the job of
  `boot.js`, loaded from `index.html` ahead of the module script. Set it later and Excalidraw
  fetches fonts from a CDN, which fails offline (text falls back to a system font).
- **`boot.js` also deletes `showSaveFilePicker` / `showOpenFilePicker`** so Excalidraw falls
  back to `<a download>`, which main catches in `downloads.ts`. Don't reintroduce the File
  System Access API.
- **The CSP lives in `src/renderer/index.html`.** If something "silently doesn't load", check
  the DevTools console for CSP violations before loosening it. Never add a remote origin.
- **Menu accelerators vs Excalidraw's key handlers.** Excalidraw listens for ⌘S, ⇧⌘S, ⌘O and
  others itself. `shortcuts.ts` installs a capture-phase `keydown` listener that calls
  `stopImmediatePropagation()` (never `preventDefault()`) for menu-owned keys, so Excalidraw
  ignores them and Electron still fires the menu accelerator. Adding a menu shortcut? Add its
  key there too.
- **Inactive tabs must not handle keys.** Hidden mounted editors stay in the DOM; make sure
  only the active editor receives keyboard and menu actions.
- **The sandboxed preload can only `import` from `electron`** (plus type-only imports, and
  `src/shared/ipc.ts` which is bundled in). No Node built-ins, no npm packages.
- **Files inside the asar are read-only.** Never write next to the app bundle; use
  `app.getPath('userData')` or a user-chosen path.
- `src/main/fileio.ts` and `src/main/recovery.ts` must not import `electron`, so Vitest can
  run them in plain Node.
- Under `file://` the origin is `"null"`, which breaks Excalidraw's asset path and workers.
  Production loads from `app://bundle/`; dev loads the Vite URL.

## Verifying a change

1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm test:e2e` (planned): runs the built app with the network blocked; any request that
   isn't `app:`, `data:` or `blob:` fails the test.
4. For UI changes, run `pnpm dev` and exercise the flow: open, edit, ⌘S, close a dirty tab,
   switch between more than 5 tabs.
5. State in your summary what you verified and what you didn't.
