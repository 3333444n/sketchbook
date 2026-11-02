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
- `src/renderer/public/boot.js` sets `window.EXCALIDRAW_ASSET_PATH` to the app's own base URL. It is loaded from
  `src/renderer/index.html` **before** the main bundle, because Excalidraw reads the variable
  at import time. Without it Excalidraw fetches fonts from a CDN; offline, text silently falls
  back to a system font.
- Excalidraw also registers every font face with a second, CDN source (`esm.sh`). The build
  (`electron.vite.config.ts`) strips that fallback from Excalidraw's dist, so no font URL ever
  points off the machine. If a future Excalidraw changes the code shape, the build fails
  loudly instead of shipping the fallback.

### 3. The network is blocked twice

- **CSP** in `src/renderer/index.html`:
  `script-src 'self' 'wasm-unsafe-eval'`, everything else `'self'` plus `data:` and `blob:`
  where Excalidraw needs them for images, fonts and workers. No remote origin is ever listed.
  `'wasm-unsafe-eval'` only allows compiling WebAssembly, which the font subsetter used by
  SVG/PNG export needs; JavaScript `eval` stays blocked. To make that work the build also
  rewrites the subsetter's embind `new Function(...)` helpers into plain closures, and keeps
  the subset worker's dependencies in their own chunk so the worker never imports the main
  app chunk (see [upgrading-excalidraw.md](upgrading-excalidraw.md)).
- **Main-process block:** a `session.webRequest.onBeforeRequest` handler in
  `src/main/protocol.ts` cancels every request whose scheme isn't `app:`, `data:`, `blob:`,
  `devtools:` or `chrome-extension:`, apart from `file:` reads inside the renderer folder made by
  the `app://` handler itself (the dev server origin is allowed in dev). Blocked requests are
  logged. This catches anything the CSP doesn't, such as requests made outside the page.

### 4. No File System Access API

`boot.js` deletes `window.showSaveFilePicker`, `window.showOpenFilePicker` and
`window.showDirectoryPicker`. Excalidraw (via
browser-fs-access) then falls back to `<a download>` and `<input type=file>`, which work in
Electron. Main handles `will-download` in `src/main/downloads.ts` with a native Save dialog.
That covers image export (PNG/SVG) and library export. `.excalidraw` open and save never use
this path; they go through IPC ([ADR 0004](adr/0004-native-dialogs-and-atomic-writes.md)).

### 5. Features that need a network are off

Collaboration, share links, AI (`aiEnabled={false}`) and online library browsing are not
included. Importing a `.excalidrawlib` file still works. Mermaid-to-diagram runs locally.

The only outbound action is an explicit user click on an external link, which opens in the
system browser via `shell.openExternal`.

### 6. The agent bridge is local IPC, not a network feature

When the user turns on **Agent ▸ Allow Agent Connections**, main listens on a **Unix domain
socket** at `userData/agent/agent.sock` ([agent-bridge.md](agent-bridge.md)). That is a file
on disk with mode `0600` in a `0700` directory, reachable only by processes of the same user
on this machine; it has no port, no address and no route. The CSP, the `webRequest` block and
the renderer are untouched: agent operations reach the renderer through the same IPC channels
as menu actions, and the offline e2e spec still records zero non-local requests with the
bridge on.

The bundled MCP server (`Contents/Resources/mcp/index.js`) runs as a separate Node process
only when an MCP client starts it. It opens the Unix socket and its own stdio, nothing else.
Its bundle contains the MCP SDK and zod, whose sources carry **spec URLs as string
constants** (`json-schema.org`, `standardschema.dev`, `github.com`, `openid.net`…) used as
schema identifiers; none is fetched. The spot check below lists them; that is expected.

## Verifying offline behaviour

### Automated

`tests/e2e/offline.spec.ts` launches the production build with an isolated profile and
records every request (in the page and in the main session) and every CSP violation. It
draws text in each font from the font picker, opens the Mermaid dialog and exports PNG and
SVG, then fails if anything non-local was requested or any CSP violation happened. Other
cases check that the main process blocks remote requests and that `app://` refuses path
traversal. `packaged.spec.ts` repeats the smoke check against the built `.app`. See
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

# Remote URLs in the MCP server bundle (expect spec identifiers only: json-schema.org, standardschema.dev, …)
grep -ohE 'https?://[a-zA-Z0-9.-]+' out/main/mcp.js | sort | uniq -c
```

## Rules

- Don't add network calls, CDNs, analytics, crash reporters or update checks.
- Don't add remote origins to the CSP.
- New assets must be bundled and resolved relative to the app's base URL.
- A dependency that phones home is a dependency we don't take.
