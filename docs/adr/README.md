# Architecture Decision Records

An ADR is a short document that records one architectural decision: the context that forced
it, what we decided, and what follows from it. They're written in
[Michael Nygard's format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
(Status, Context, Decision, Consequences).

## When to write one

Write an ADR when a change affects the architecture: process model, IPC shape or ownership,
storage formats, security or offline guarantees, build/packaging, or a dependency with a large
footprint. Bug fixes and features that fit the existing design don't need one.

## How

1. Copy [0000-template.md](0000-template.md) to `NNNN-short-title.md` with the next number.
2. Fill it in. Be honest about rejected alternatives and costs.
3. Open it in a PR (it can be the same PR as the change). Status starts as **Proposed** and
   becomes **Accepted** when merged.
4. ADRs are immutable once accepted. To change a decision, write a new ADR and mark the old
   one **Superseded by NNNN**.

## Index

| # | Title | Status | Date |
|---|---|---|---|
| [0001](0001-embed-excalidraw-in-electron.md) | Embed `@excalidraw/excalidraw` in Electron | Accepted | 2026-10-22 |
| [0002](0002-electron-vite-and-electron-builder.md) | Build with electron-vite and package with electron-builder | Accepted | 2026-10-22 |
| [0003](0003-app-protocol-and-bundled-fonts.md) | `app://` protocol and bundled fonts for offline use | Accepted | 2026-10-22 |
| [0004](0004-native-dialogs-and-atomic-writes.md) | Native file dialogs and atomic writes instead of the File System Access API | Accepted | 2026-10-22 |
| [0005](0005-recovery-journal.md) | Recovery journal instead of autosave-overwrite | Accepted | 2026-10-22 |
| [0006](0006-tabs-with-mru-editor-budget.md) | Tabs in one renderer with an MRU budget of 5 mounted editors | Accepted | 2026-10-22 |
| [0007](0007-frameless-window-custom-tab-strip.md) | Frameless window with a custom tab strip | Accepted | 2026-10-22 |
| [0008](0008-product-name-and-attribution.md) | Product name "Sketchbook" and Excalidraw attribution | Accepted | 2026-10-22 |
