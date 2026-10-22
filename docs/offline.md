# Offline by construction

Sketchbook must work with no network at all: on a plane, behind a captive portal, with Wi-Fi
off. This isn't a cache that might be warm; nothing the app needs lives anywhere but the app
bundle. Decision record: [ADR 0003](adr/0003-app-protocol-and-bundled-fonts.md).

## How it works

### 1. The renderer is served from `app://bundle/`

In production the renderer loads from a custom privileged scheme instead of `file://`.

- Under `file://` the page origin is `"null"`. Excalidraw derives its asset path from the
  origin and spawns workers, and both break (workers fail with a `SecurityError`).
- `src/main/protocol.ts` registers `app` with `protocol.registerSchemesAsPrivileged` (standard,
  secure, fetch support) before `ready`, then serves `out/renderer` with `protocol.handle`.
  The handler resolves paths inside the renderer directory only.
- In development the renderer loads from the Vite dev server URL instead.

### 2. Fonts are bundled

- Excalidraw's fonts (about 13 MB, including the CJK font Xiaolai) are copied from
  `node_modules/@excalidraw/excalidraw/dist/prod/fonts` into the renderer build.
- `boot.js` sets `window.EXCALIDRAW_ASSET_PATH` to the app's own base URL. It is loaded from
  `src/renderer/index.html` **before** the main bundle, because Excalidraw reads the variable
  at import time. Without it Excalidraw fetches fonts from a CDN; offline, text silently falls
  back to a system font.

### 3. The network is blocked twice

- **CSP** in `src/renderer/index.html` allows only `'self'` (plus `data:` and `blob:` where
  Excalidraw needs them for images, fonts and workers). No remote origin is ever listed.
- **Main-process block:** a `session.webRequest.onBeforeRequest` handler cancels every request
  whose scheme isn't `app:`, `data:` or `blob:` (the dev server origin is allowed in dev).
  This catches anything the CSP doesn't, such as requests made outside the page.

### 4. No File System Access API

`boot.js` deletes `window.showSaveFilePicker` and `window.showOpenFilePicker`. Excalidraw (via
browser-fs-access) then falls back to `<a download>` and `<input type=file>`, which work in
Electron. Main handles `will-download` in `src/main/downloads.ts` with a native Save dialog.
That covers image export (PNG/SVG) and library export. `.excalidraw` open and save never use
this path; they go through IPC ([ADR 0004](adr/0004-native-dialogs-and-atomic-writes.md)).

### 5. Features that need a network are off

Collaboration, share links, AI (`aiEnabled={false}`) and online library browsing are not
included. Importing a `.excalidrawlib` file still works. Mermaid-to-diagram runs locally.

The only outbound action is an explicit user click on an external link, which opens in the
system browser via `shell.openExternal`.

## Verifying offline behaviour

### Automated

The e2e suite (planned, `tests/e2e/`) launches the production build with every request that
isn't `app:`, `data:` or `blob:` failing the test, then checks that the canvas renders and
that `document.fonts.check('20px Excalifont')` is true after drawing text. See
[testing.md](testing.md).

### Manual

1. `pnpm build:mac` and install the dmg.
2. Turn Wi-Fi off (or use Network Link Conditioner with 100% loss).
3. Launch, draw shapes and text. The text must render in the hand-drawn font, and CJK text in
   Xiaolai.
4. Export PNG and SVG; open the exported PNG again.
5. Insert a Mermaid diagram.
6. Open DevTools (⌥⌘I) → Console and Network: there must be no failed remote requests or CSP
   violations.

### Spot checks when reviewing a PR

```bash
# Remote URLs introduced in source or config
git diff main -- src electron.vite.config.ts | grep -nE 'https?://'

# Remote URLs in the built renderer (expect only links shown to the user, e.g. GitHub)
pnpm exec electron-vite build && grep -rhoE 'https?://[a-zA-Z0-9.-]+' out/renderer | sort | uniq -c
```

## Rules

- Don't add network calls, CDNs, analytics, crash reporters or update checks.
- Don't add remote origins to the CSP.
- New assets must be bundled and resolved relative to the app's base URL.
- A dependency that phones home is a dependency we don't take.
