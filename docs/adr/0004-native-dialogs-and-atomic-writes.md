# 0004. Native file dialogs and atomic writes instead of the File System Access API

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Excalidraw opens and saves through `browser-fs-access`, which uses the File System Access API
(`showSaveFilePicker`, `showOpenFilePicker`) when present. In Electron that path is unreliable
(Excalidraw issues #6750 and #7787), and it gives the renderer, the least trusted layer, the
power to choose where files are written. A desktop app should also behave like one: native
dialogs, Finder association, Open Recent, the edited dot, the proxy icon.

A crash or power loss in the middle of a save must never leave a truncated drawing.

## Decision

We will:

- Turn off Excalidraw's own load/save canvas actions and drive `.excalidraw` open/save from
  the native menu and our own MainMenu items over a typed IPC contract
  ([ipc-contract.md](../ipc-contract.md)).
- Have **main** own every path. The renderer sends a `docId` and contents; main writes only to
  a path it obtained from its own dialog or already tracks for that doc.
- Write atomically in `src/main/fileio.ts`: write a temp file in the target directory, `fsync`
  it, then `rename` it over the target.
- Remove the File System Access API in `boot.js` so Excalidraw's image and library export fall
  back to `<a download>`; main handles `will-download` with a native Save dialog
  (`src/main/downloads.ts`).
- Open PNG/SVG files with an embedded scene; saving one becomes Save As `.excalidraw`, so we
  never rewrite an image the user exported.
- Integrate with Finder: `.excalidraw` file association, `open-file`, Open Recent and a
  single-instance lock (`src/main/finder.ts`).

## Consequences

- A compromised or buggy renderer can't write arbitrary files.
- Saves are crash-safe: readers see the old file or the new one, never half of one.
- Native UX: dialogs, recent documents, proxy icon, document-edited state.
- We maintain our own menus and save flows instead of using Excalidraw's.
- Atomic rename replaces the file's inode, so extended attributes and hard links on the
  original are not preserved.
