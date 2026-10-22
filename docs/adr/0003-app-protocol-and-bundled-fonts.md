# 0003. `app://` protocol and bundled fonts for offline use

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Sketchbook must work with no network. Two things break that by default:

- Loading the renderer with `file://` gives the page a `"null"` origin. Excalidraw derives its
  asset path from the page URL and starts workers; under `file://` the asset path is wrong and
  workers fail with a `SecurityError`.
- Excalidraw fetches its fonts (about 13 MB, including the CJK font Xiaolai) from a CDN unless
  `window.EXCALIDRAW_ASSET_PATH` points elsewhere. Offline, text falls back to a system font.

We also want a guarantee, not just a default, that nothing reaches the network.

## Decision

We will:

1. Serve the production renderer from a custom privileged scheme, `app://bundle/`, registered
   with `registerSchemesAsPrivileged` (standard, secure, fetch support) and handled with
   `protocol.handle` in `src/main/protocol.ts`. Dev uses the Vite URL.
2. Copy Excalidraw's font directory into the renderer build and set
   `window.EXCALIDRAW_ASSET_PATH` in `boot.js`, loaded from `index.html` before the bundle.
3. Enforce offline twice: a strict CSP in `src/renderer/index.html` with no remote origins, and
   a main-process `webRequest` handler that cancels any request that isn't `app:`, `data:` or
   `blob:`.
4. Disable Excalidraw features that need the network (collaboration, share links, AI, online
   library).

## Consequences

- The app behaves the same on a plane as online, and a test with the network blocked can
  prove it.
- The app is about 13 MB larger because of the fonts.
- `boot.js` must stay ahead of the bundle; reordering `index.html` silently breaks fonts.
- New features that need remote resources can't be added without revisiting this ADR.
- The custom protocol handler is security-sensitive: it must resolve paths only inside the
  renderer output directory.
