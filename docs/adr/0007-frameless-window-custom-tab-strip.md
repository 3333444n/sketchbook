# 0007. Frameless window with a custom tab strip

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

With tabs ([0006](0006-tabs-with-mru-editor-budget.md)), a standard macOS title bar plus a
tab row would stack two bars above the canvas. Excalidraw's UI floats over a full-bleed
canvas; extra chrome with a visible border makes the app feel less like excalidraw.com.
macOS native window tabs only work with one `BrowserWindow` per tab, which 0006 rejects.

## Decision

We will use `titleBarStyle: 'hidden'` and draw our own 40px tab strip in the renderer:

- The traffic lights are positioned inside the strip.
- The strip is a drag region (`-webkit-app-region: drag`); tabs and buttons in it are
  `no-drag`.
- The strip uses the canvas background colour, so there is no title-bar border.
- In native full screen the traffic lights are hidden, so main reports full-screen changes
  (`onFullScreenChange`) and the strip drops its left inset.
- Main still sets the window title, represented filename and document-edited state from the
  active tab, for Mission Control, the Window menu and accessibility.

## Consequences

- One compact bar, visually continuous with the canvas.
- We own tab-strip behaviour: dragging the window, double-click to zoom, overflow, keyboard
  access and accessibility labels.
- The strip must follow theme and canvas background changes.
- Traffic-light positioning is macOS-specific; other platforms would need a different layout.
