# Upgrading Excalidraw

Sketchbook pins `@excalidraw/excalidraw` to an exact version (0.18.1) because several pieces
depend on its internals. Bump it on purpose, in its own PR, and walk through this list.

## 1. Build-time patches (`electron.vite.config.ts`)

The `sketchbook-excalidraw-offline` plugin rewrites Excalidraw's published `dist/` files:

| Patch                                                                                        | Why                                                                                                                                                       | If it fails                                                                                                                      |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Strip `urls.push(new URL(x, Foo.ASSETS_FALLBACK_URL))`                                       | Removes the `esm.sh` CDN font fallback, which is useless offline and trips the CSP.                                                                       | Find how the new version builds font URLs and remove any non-local source.                                                       |
| Rewrite embind `createNamedFunction` and `makeDynCaller` (`new Function(...)`) into closures | Font subsetting for export must run under `script-src 'self' 'wasm-unsafe-eval'`, without `'unsafe-eval'`.                                                | Find the new eval sites in the subsetter's glue and replace them with equivalent closures. Never add `'unsafe-eval'` to the CSP. |
| Pin `subset-worker.chunk.js`'s import closure into an `excalidraw-subset` chunk              | The worker must not import the main chunk (it touches `window` and would crash the worker, pushing subsetting onto the main thread, where it needs eval). | Check the worker file name and its imports in `dist/prod/`.                                                                      |

Each patch throws, and the build fails, when the pattern isn't found or a `new Function` is
left over. A failing build after a bump is the expected signal, not a bug in the build.

## 2. Font paths

- Fonts are copied from `node_modules/@excalidraw/excalidraw/dist/prod/fonts` into
  `out/renderer/fonts` by `vite-plugin-static-copy` (`stripBase: 6` depends on that path
  depth).
- Excalidraw requests `${EXCALIDRAW_ASSET_PATH}fonts/<Family>/<file>.woff2`, and
  `src/renderer/public/boot.js` sets `EXCALIDRAW_ASSET_PATH` before the bundle loads.
- After a bump, check that the folder layout and the variable name are unchanged, that any new
  font families are copied, and that [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)
  lists them.

## 3. `portalGuard.ts`

`src/renderer/src/portalGuard.ts` hides confirm-dialog portals that belong to hidden editors,
because Excalidraw 0.18 shares jotai UI state across instances. It finds a portal's owner by
walking React's internal fiber (`__reactFiber$…`). After a bump (or a React upgrade):

1. Open three tabs with content, open "Clear canvas" from the main menu in one of them and
   confirm: only that tab is cleared, and only one dialog is visible.
2. If Excalidraw now scopes that state per instance, the guard can be removed.
3. If portals are no longer direct children of `<body>` with the `excalidraw` class, the guard
   silently does nothing (it fails safe: portals stay visible), so step 1 is what catches it.

## 4. Offline e2e spec

Run the whole suite, and pay attention to `tests/e2e/offline.spec.ts`:

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e
```

The offline spec draws text in every font in the font picker, opens the Mermaid dialog and
exports PNG and SVG, failing on any non-local request or CSP violation. If a new version
adds a font, a lazy chunk or a feature that fetches something, this is where it shows up.
New UI that needs a server (collaboration, AI, online libraries) must stay disabled.

## 5. Also check

- `useDocument.ts` / `blob.ts`: `loadFromBlob`, `serializeAsJSON` and `restore` behaviour for
  open, save, eviction snapshots and PNG/SVG with an embedded scene.
- `AppMainMenu.tsx`, `AppWelcomeScreen.tsx`: the `MainMenu` and `WelcomeScreen` APIs.
- `shortcuts.ts`: Excalidraw's own key bindings, in case new ones collide with menu keys.
- `DocumentEditor.tsx`: the dialog names used for `export-image` (`imageExport`) and
  `mermaid` (`ttd` / `mermaid`).
- `pnpm screenshots` if the UI changed visibly.
- `agentOps.ts` / `agentScene.ts`: `convertToExcalidrawElements`, `restoreElements`,
  `newElementWith`, `exportToBlob`, `CaptureUpdateAction.IMMEDIATELY`, and the element shapes
  `agentScene.ts` builds by hand (arrow `startBinding`/`endBinding` with `focus`/`gap`/
  `fixedPoint`, `boundElements`, `containerId`, fractional `index` of appended elements, and
  the bound-label padding in `boundTextPosition`).
  `pnpm test` covers the pure parts; `tests/e2e/agent.spec.ts` exercises a real editor. After
  a bump, also ask an agent for a labelled box, a bound arrow and a frame, then ⌘Z three times.
