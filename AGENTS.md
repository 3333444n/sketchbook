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

| Path                                  | What                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/shared/ipc.ts`                   | **The IPC contract (v2: tabs).** Types plus channel names. Every layer codes against it.                               |
| `src/shared/chrome.ts`                | Window-chrome geometry (tab-strip height, traffic-light inset and position) shared by main and renderer.               |
| `src/preload/index.ts`                | Implements `SketchbookAPI` on `window.sketchbook` via `contextBridge`.                                                 |
| `src/main/index.ts`                   | Thin bootstrap: scheme registration, `initDocuments()`, `buildMenu()`.                                                 |
| `src/main/protocol.ts`                | `app://bundle/` scheme and renderer loading.                                                                           |
| `src/main/documents.ts`               | Windows, open/save, close/quit prompts, IPC handlers, link policy.                                                     |
| `src/main/registry.ts`                | Pure window/doc registry (which docs live in which window, paths, dirty, active). No `electron` import.                |
| `src/main/fileio.ts`                  | Pure file helpers: `atomicWrite`, extensions, `readDocContents`. No `electron` import.                                 |
| `src/main/recovery.ts`                | Crash-recovery journal in `userData/recovery/`. No `electron` import.                                                  |
| `src/main/finder.ts`                  | Single-instance lock, `open-file`, argv paths.                                                                         |
| `src/main/downloads.ts`               | `will-download` → native Save dialog (image export, library export).                                                   |
| `src/main/menu.ts`                    | Native application menu and accelerators.                                                                              |
| `src/main/__tests__/`                 | Vitest unit tests (node environment).                                                                                  |
| `src/renderer/index.html`             | Renderer entry; **the CSP meta tag lives here**.                                                                       |
| `src/renderer/public/boot.js`         | Classic script run before the bundle: sets `EXCALIDRAW_ASSET_PATH`, hides the File System Access API.                  |
| `src/renderer/src/App.tsx`            | Window shell: tab model, MRU editor budget, theme, library, shared shortcuts.                                          |
| `src/renderer/src/tabs.ts`            | Types shared by App and its editors (`EditorHandle`, `EditorSnapshot`, `EditorEvents`).                                |
| `src/renderer/src/DocumentEditor.tsx` | One drawing: an `<Excalidraw>` instance plus its lifecycle.                                                            |
| `src/renderer/src/useDocument.ts`     | Per-document state: load, dirty/empty, debounced autosave, save.                                                       |
| `src/renderer/src/bridge.ts`          | Thin adapter over `window.sketchbook`.                                                                                 |
| `src/renderer/src/shortcuts.ts`       | Capture-phase key handlers: yield menu-owned keys to the native menu, ⌘1–⌘9, stray-key forwarding.                     |
| `src/renderer/src/portalGuard.ts`     | Hides dialog portals that belong to hidden editors (see Gotchas).                                                      |
| `src/renderer/src/components/`        | `TabStrip`, `AppMainMenu`, `AppWelcomeScreen`, icons.                                                                  |
| `electron.vite.config.ts`             | Build, including the Excalidraw offline patches (see Gotchas).                                                         |
| `electron-builder.yml`                | Packaging (ad-hoc-signed arm64 dmg, `.excalidraw` file association).                                                   |
| `tests/e2e/`, `playwright.config.ts`  | Playwright `_electron` tests against the production build.                                                             |
| `scripts/screenshots.mjs`             | Regenerates the README images in `docs/images/` (`pnpm screenshots`).                                                  |
| `docs/`                               | Architecture, IPC reference, offline, performance, testing, release, upgrading Excalidraw, [ADRs](docs/adr/README.md). |

## Commands

```bash
pnpm i             # install (also installs Electron and app deps)
pnpm dev           # run with hot reload
pnpm lint          # ESLint (+ Prettier as a lint rule)
pnpm typecheck     # tsc for node (main/preload/shared) and web (renderer)
pnpm test          # Vitest unit tests
pnpm test:e2e      # build, then Playwright _electron e2e against the production build
pnpm screenshots   # build, then regenerate docs/images/*.png
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
- **Menu accelerators vs Excalidraw's key handlers.** The native menu (`src/main/menu.ts`) owns
  ⌘T, ⌘N, ⌘O, ⌘S, ⇧⌘S, ⇧⌘E, ⌘W, ⇧⌘W, ⌃Tab / ⌃⇧Tab and the hidden ⇧⌘] / ⇧⌘[ aliases.
  Excalidraw listens for some of these itself, so `useMenuOwnedShortcuts` in `shortcuts.ts`
  calls `stopImmediatePropagation()` (never `preventDefault()`) for ⌘ plus `s`, `o`, `n`, `t`
  or `w` (with or without ⇧): Excalidraw ignores them and Electron still fires the menu
  accelerator. ⇧⌘E is not intercepted; Excalidraw's handler and the menu both open the same
  export dialog. ⌘1–⌘9 have no menu items: `useTabNumberShortcuts` handles them in the
  renderer (⌘9 is the last tab) and swallows them. Adding a menu shortcut that Excalidraw
  also binds? Add its key to `MENU_OWNED_KEYS`.
- **Inactive tabs must not handle keys.** Hidden mounted editors stay in the DOM; make sure
  only the active editor receives keyboard and menu actions.
- **`portalGuard.ts` is a known fragile spot.** Excalidraw 0.18 keeps some UI state in a
  module-level jotai store shared by every instance, so a confirm dialog (for example "Clear
  canvas") opened in one editor renders a body-level portal in _every_ mounted editor. The
  guard walks each portal's React fiber (`__reactFiber$…`, a React internal) up to its
  `.sketchbook-editor[data-doc-id]` wrapper and hides portals of inactive editors. It fails
  safe: if the fiber walk finds no owner, the portal is left visible (today's behaviour
  without the guard). Re-check it on every React or Excalidraw upgrade.
- **`electron.vite.config.ts` patches Excalidraw's dist at build time**: it strips the CDN
  (`esm.sh`) font fallback, rewrites the embind `new Function` helpers into closures so export
  works without `'unsafe-eval'`, and pins the font-subset worker's dependencies into their own
  chunk. Each patch throws and fails the build if Excalidraw's code shape changes. See
  [docs/upgrading-excalidraw.md](docs/upgrading-excalidraw.md).
- **The sandboxed preload can only `import` from `electron`** (plus type-only imports, and
  `src/shared/ipc.ts` which is bundled in). No Node built-ins, no npm packages.
- **Files inside the asar are read-only.** Never write next to the app bundle; use
  `app.getPath('userData')` or a user-chosen path.
- `src/main/fileio.ts`, `src/main/recovery.ts` and `src/main/registry.ts` must not import `electron`, so Vitest can
  run them in plain Node.
- Under `file://` the origin is `"null"`, which breaks Excalidraw's asset path and workers.
  Production loads from `app://bundle/`; dev loads the Vite URL.

## Verifying a change

1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm test:e2e`: builds, then runs the production app with an isolated profile; any
   non-local request or CSP violation fails the offline spec.
4. For UI changes, run `pnpm dev` and exercise the flow: open, edit, ⌘S, close a dirty tab,
   switch between more than 5 tabs.
5. State in your summary what you verified and what you didn't.
