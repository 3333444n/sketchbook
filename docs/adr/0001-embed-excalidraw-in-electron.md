# 0001. Embed `@excalidraw/excalidraw` in Electron

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

We want excalidraw.com's drawing experience on macOS with no network: real `.excalidraw`
files that open and save like documents, crash safety, Finder integration, and multiple
windows. excalidraw.com needs a connection, or a PWA install that may not have cached
everything.

Options considered:

- **Install excalidraw.com as a PWA.** No native file handling, no Finder association, and
  offline support depends on what the service worker cached. Not reliable on a plane.
- **pgkt04/excalidraw-desktop.** Wraps the live site in a window, so it needs the network and
  inherits the site's browser-storage persistence.
- **The official excalidraw-desktop.** Deprecated and unmaintained.
- **ExcalidrawZ.** A native Swift app. Good, but it's a different codebase and stack from the
  one we want to own and extend.
- **Fork excalidraw-app.** The full website app brings collaboration, Firebase, share links
  and AI that we'd have to strip, and every upstream update becomes a merge.
- **Tauri.** Smaller binaries, but WKWebView behaviour differs from Chromium (fonts, workers,
  canvas, clipboard), and Excalidraw is developed and tested against Chromium-class browsers.
- **Embed the `@excalidraw/excalidraw` npm package in Electron.**

## Decision

We will embed the official MIT-licensed `@excalidraw/excalidraw` component (pinned, currently
0.18.1) in an Electron app, as an npm dependency. We will not fork excalidraw-app.

What exists only in excalidraw-app (persistence, welcome screen, main menu) is rebuilt in
`src/renderer/`. Collaboration, share links, AI and online library browsing are out of scope.

## Consequences

- Upgrading Excalidraw is a dependency bump plus testing, not a merge.
- The UI looks and behaves like excalidraw.com, because it is the same component.
- We own persistence, menus, file IO and the welcome screen, and must keep them working across
  Excalidraw releases.
- Electron apps are large (Chromium is bundled) and use more memory than a native app.
- Chromium gives us consistent rendering, fonts, workers and clipboard behaviour.
