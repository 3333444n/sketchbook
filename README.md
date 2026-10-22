# Sketchbook

Sketchbook is an offline whiteboard app for macOS (Apple Silicon). It wraps the
[Excalidraw](https://github.com/excalidraw/excalidraw) editor in a native
desktop app. Your drawings are ordinary `.excalidraw` files on disk, and the
app never connects to the network.

> Built with Excalidraw (MIT). Sketchbook is an independent project and is not
> affiliated with or endorsed by Excalidraw. See
> [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Features

- The full Excalidraw editor: shapes, arrows, freehand, text, images, frames,
  Mermaid-to-diagram, and the library.
- Fully offline. Every asset, including all of Excalidraw's fonts (Excalifont,
  Nunito, Comic Shanns, Lilita One and the rest), ships inside the app. A
  network guard in the main process blocks any request that isn't local, so
  the app behaves the same with or without Wi-Fi.
- Native documents: open, save and save-as `.excalidraw` files, one window per
  drawing, and opening files from Finder.
- Export to PNG or SVG through a native Save dialog.

## Install (from the .dmg)

1. Open `Sketchbook-<version>-arm64.dmg` and drag **Sketchbook** into
   **Applications**.
2. The app is ad-hoc signed but not notarized by Apple, so the first launch is
   blocked:
   - Try to open it once, then go to **System Settings → Privacy & Security**
     and click **Open Anyway** next to the Sketchbook message, or
   - run this in Terminal:

     ```sh
     xattr -cr /Applications/Sketchbook.app
     ```

After that it opens normally.

## Development

Requires Node 24 and pnpm.

```sh
pnpm i            # install dependencies
pnpm dev          # run with hot reload (electron-vite dev server)
pnpm build        # typecheck + production build into out/
pnpm build:mac    # build dist/Sketchbook-<version>-arm64.dmg
pnpm test         # unit tests (vitest)
pnpm test:e2e     # build, then run the Playwright/Electron end-to-end tests
pnpm icons        # regenerate build/icon.{png,icns} + resources/icon.png from build/icon.svg
```

### How offline works

- **`app://` scheme** (`src/main/protocol.ts`): in production the UI is served
  from `app://bundle/…`, a privileged, standard and secure scheme backed by
  `out/renderer`. Requests that try to leave that folder get a 404.
- **Fonts**: `electron.vite.config.ts` copies
  `@excalidraw/excalidraw/dist/prod/fonts` into `out/renderer/fonts`. Then
  `src/renderer/public/boot.js` sets `window.EXCALIDRAW_ASSET_PATH` to the app
  origin. The build also removes Excalidraw's CDN fallback (`esm.sh`) for
  font URLs.
- **Strict CSP** (`src/renderer/index.html`): `script-src 'self'
'wasm-unsafe-eval'` blocks inline scripts and JS `eval`. The font subsetter
  used by SVG export needs WebAssembly, which is why `'wasm-unsafe-eval'` is
  allowed. The build rewrites the subsetter's small embind `new Function`
  helpers into plain closures, and keeps its Web Worker chunk separate from the
  main chunk.
- **Network guard**: `session.webRequest.onBeforeRequest` cancels anything
  that isn't `app:`, `data:`, `blob:` or `devtools:` (plus the Vite dev server
  during `pnpm dev`) and logs what it blocked.
- **Save/open dialogs**: `boot.js` hides the File System Access API, so
  Excalidraw falls back to downloads and `<input type=file>`. The main process
  turns those into native dialogs.

### End-to-end tests

`pnpm test:e2e` launches the production build (`out/main/index.js`) with an
isolated `--user-data-dir`. The offline spec records every request and CSP
violation while it draws text in each font, opens the Mermaid dialog and
exports PNG and SVG. It fails if anything non-local is requested or any CSP
violation happens.

## Limitations

Sketchbook leaves out the parts of excalidraw.com that need a server:

- No live collaboration and no shareable links.
- No AI features (text-to-diagram, wireframe-to-code).
- No browsing or installing from the online library at libraries.excalidraw.com.
  You can still import local `.excalidrawlib` files.
- macOS on Apple Silicon only.

## License

[MIT](LICENSE). Third-party components and fonts are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
