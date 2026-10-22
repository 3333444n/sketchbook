# 0006. Tabs in one renderer with an MRU budget of 5 mounted editors

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

v1 used one `BrowserWindow` per document. Users with several drawings open want tabs (⌘T,
⌘W, ⌘1–9, ⌃Tab) as well as multiple windows (⌘N, ⇧⌘W). The question is how to host many
Excalidraw editors without memory and latency growing with the tab count.

Options considered:

- **`WebContentsView` per tab.** Strong isolation, but one renderer process per tab (roughly
  100+ MB each). Too heavy for a sketching app with a dozen tabs, and it complicates the tab
  strip and focus handling.
- **All tabs mounted in one renderer.** Instant switching, but every tab keeps its scene,
  canvases, caches and React tree alive, so memory grows linearly.
- **Only the active tab mounted.** Lowest memory, but every switch pays a full remount and
  loses undo history.
- **One renderer per window with an MRU budget of mounted editors.**

## Decision

We will host all tabs of a window in one renderer process and keep at most **5** Excalidraw
editors mounted, chosen by most recent use.

- Inactive mounted editors are hidden and do not handle keys or menu actions.
- When a tab falls out of the budget, its scene is snapshotted to JSON and its editor is
  unmounted. Activating it remounts from the snapshot.
- Main is the source of truth for docs, paths and dirty state; the renderer owns tab order,
  the active tab and the UI. The IPC contract moved to v2 to carry a `docId` on every
  per-document call ([ipc-contract.md](../ipc-contract.md)).
- Per-document state lives entirely in `DocumentEditor` / `useDocument` so editors coexist.

## Consequences

- Switching among the 5 most recent tabs is instant; memory is bounded regardless of tab
  count.
- An evicted tab loses its undo history when it remounts. This is a visible trade-off.
- A renderer crash takes down all tabs in that window (recovery journals limit the damage).
- Code must respect the budget: nothing expensive per mounted editor, and hidden editors must
  stay inert. See [performance.md](../performance.md).
