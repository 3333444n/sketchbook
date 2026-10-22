# Architecture

Sketchbook is an Electron app with the standard three layers. The only thing that crosses
layers is the contract in [`src/shared/ipc.ts`](../src/shared/ipc.ts) (v2: tabs), documented
in [ipc-contract.md](ipc-contract.md).

## Processes and layers

```mermaid
flowchart LR
  subgraph Main["Main process (Node, privileged)"]
    idx["index.ts<br/>bootstrap"]
    docs["documents.ts<br/>windows, open/save,<br/>prompts, IPC"]
    reg["registry.ts<br/>docs per window"]
    menu["menu.ts<br/>native menu"]
    proto["protocol.ts<br/>app://bundle/"]
    dl["downloads.ts<br/>will-download"]
    fio["fileio.ts<br/>atomicWrite"]
    rec["recovery.ts<br/>journal"]
    finder["finder.ts<br/>open-file, single instance"]
  end

  subgraph Win["BrowserWindow (one per window)"]
    pre["preload/index.ts<br/>window.sketchbook"]
    subgraph R["Renderer process (React)"]
      app["App.tsx + TabStrip<br/>tabs, theme, library"]
      ed1["DocumentEditor<br/>+ useDocument (tab 1)"]
      ed2["DocumentEditor<br/>+ useDocument (tab 2)"]
    end
  end

  disk[("Disk:<br/>.excalidraw files,<br/>userData/recovery/")]

  idx --> docs
  idx --> menu
  idx --> proto
  docs --> reg
  docs --> fio
  docs --> rec
  docs --> finder
  docs --> dl
  menu -->|"MenuAction"| docs
  docs <-->|"IPC channels (ipc.ts)"| pre
  pre <-->|"contextBridge"| app
  app --> ed1
  app --> ed2
  fio --> disk
  rec --> disk
  proto -->|"serves out/renderer"| R
```

### Who owns what

| State                                             | Owner                                       |
| ------------------------------------------------- | ------------------------------------------- |
| Which docs exist, which window each lives in      | Main                                        |
| Each doc's path, dirty and empty flags            | Main (renderer reports dirty/empty)         |
| Window title, proxy icon, close-button dot        | Main (from the active doc)                  |
| Disk writes, dialogs, recovery journal            | Main                                        |
| Tab order, active tab, tab-strip UI               | Renderer                                    |
| Scene contents, undo history, Excalidraw UI state | Renderer (`DocumentEditor` / `useDocument`) |
| Theme preference, shape library                   | Renderer (`localStorage`, never scene data) |

### Windows and tabs

- Each window hosts an ordered set of tabs; each tab is one document with a stable `docId`.
- All tabs in a window share **one renderer process**. At most 5 Excalidraw editors are
  mounted, by most recent use; older tabs are snapshotted to JSON and remount on demand. See
  [performance.md](performance.md) and [ADR 0006](adr/0006-tabs-with-mru-editor-budget.md).
- The window is frameless (`titleBarStyle: 'hidden'`) with the traffic lights inside a 40px
  tab strip that doubles as the drag region. See [ADR 0007](adr/0007-frameless-window-custom-tab-strip.md).

| Shortcut                      | Action                                 | Handled by                       |
| ----------------------------- | -------------------------------------- | -------------------------------- |
| ⌘T                            | New tab                                | Main (menu)                      |
| ⌘N                            | New window                             | Main (menu)                      |
| ⌘O                            | Open (into the current window as tabs) | Main (menu)                      |
| ⌘S / ⇧⌘S                      | Save / Save As                         | Menu → `onMenu` → active tab     |
| ⇧⌘E                           | Export image                           | Menu → `onMenu` → active tab     |
| ⌘W                            | Close tab                              | Menu → `onMenu` → close-tab flow |
| ⇧⌘W                           | Close window                           | Main (menu)                      |
| ⌘1–⌘8, ⌘9                     | Switch to tab N; ⌘9 is the last tab    | Renderer (`shortcuts.ts`)        |
| ⌃Tab / ⌃⇧Tab (also ⇧⌘] / ⇧⌘[) | Next / previous tab                    | Menu → `onMenu` → renderer       |

Excalidraw binds some of the same keys. The renderer stops them from reaching Excalidraw
without cancelling them, so the menu accelerator still fires; see `src/renderer/src/shortcuts.ts`
and the gotchas in [AGENTS.md](../AGENTS.md).

### Security boundaries

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` on every window.
- The preload exposes only `SketchbookAPI`. Main validates the sender and arguments of every
  message and only acts on `docId`s that belong to the sending window.
- Main never writes to a path supplied by the renderer: only to a path it obtained from its own
  dialog or already tracks for that doc.
- Navigation away from the app is blocked; `window.open` is denied. External links go through
  `shell.openExternal` for `http:`, `https:` and `mailto:` only.
- Offline enforcement (CSP and `webRequest` block) is described in [offline.md](offline.md).

## Flows

### Open

```mermaid
sequenceDiagram
  actor U as User
  participant M as Main
  participant R as Renderer
  U->>M: File > Open (Cmd+O), Finder double-click, or Open Recent
  M->>M: native Open dialog, then readDocContents(path)
  alt file already open in some tab
    M->>R: onActivateDoc(docId) in that window, focus window
  else active tab is untitled, clean and empty
    M->>R: onOpenDocs([payload with the same docId], docId)
    R->>R: replace that tab's document
  else
    M->>R: onOpenDocs([payload with new docId], docId)
    R->>R: append tab and activate it
  end
  R->>M: setActiveDoc(docId)
  M->>M: update title, proxy icon, addRecentDocument
```

PNG and SVG files with an embedded scene open like any other document. Because they aren't
the native format, a plain Save on them behaves as Save As `.excalidraw`.

### Save

```mermaid
sequenceDiagram
  actor U as User
  participant M as Main
  participant R as Renderer (active tab)
  U->>M: Cmd+S (menu accelerator)
  M->>R: onMenu("save")
  R->>R: serializeAsJSON(scene)
  R->>M: save(docId, contents, saveAs false)
  alt doc has a native .excalidraw path and not Save As
    M->>M: target = tracked path
  else
    M->>M: native Save dialog, target = chosen path
  end
  M->>M: atomicWrite(target) = temp file, fsync, rename
  M->>M: dirty = false, delete recovery journal
  M-->>R: path (or null if cancelled or failed)
  R->>R: reset dirty baseline
```

### Close a tab (Cmd+W)

```mermaid
sequenceDiagram
  actor U as User
  participant M as Main
  participant R as Renderer
  U->>M: Cmd+W
  M->>R: onMenu("close-tab")
  R->>M: requestCloseDoc(docId)
  alt doc is clean
    M-->>R: "close"
  else doc is dirty
    M->>U: Save / Don't Save / Cancel
    U-->>M: choice
    M-->>R: "save", "close" or "cancel"
  end
  opt "save"
    R->>M: save(docId, ...)
    M-->>R: path or null
  end
  alt closed, or saved successfully
    R->>R: remove tab
    R->>M: docClosed(docId)
    M->>M: forget doc, delete journal, close window if it was the last tab
  else cancelled or save failed
    R->>R: keep tab
  end
```

### Close a window or quit

```mermaid
sequenceDiagram
  actor U as User
  participant M as Main
  participant R as Renderer
  U->>M: Shift+Cmd+W, red close button, or Cmd+Q
  loop each dirty doc (in each affected window)
    M->>R: onActivateDoc(docId)
    M->>U: Save / Don't Save / Cancel
    alt Save
      M->>R: onSaveAndClose(docId)
      R->>M: save(docId, contents, saveAs false)
      M-->>R: path, or null which aborts the close
    else Don't Save
      M->>M: delete journal
    else Cancel
      M->>M: abort the close or quit
    end
  end
  M->>M: destroy window(s), or app.quit()
```

### Crash recovery

```mermaid
sequenceDiagram
  participant R as Renderer
  participant M as Main
  participant J as userData/recovery
  R->>R: scene changes, debounce 1 s
  R->>M: autosave(docId, contents)
  alt doc is dirty
    M->>J: atomicWrite docId.json with path and contents
  else clean
    M->>M: ignore
  end
  Note over M,J: Saved or "Don't Save" deletes the journal.<br/>The user's file only changes on Cmd+S.
  Note over R,J: ... crash or kill -9 ...
  M->>J: scanJournals() at launch
  J-->>M: leftover journals
  M->>R: getInitialState returns docs with recovered true
  R->>R: show as dirty tabs, toast "Recovered unsaved changes"
```

Corrupt journals are moved to `userData/recovery/corrupt/` so they never block startup.
See [ADR 0005](adr/0005-recovery-journal.md).

## Known fragile spots

- **`src/renderer/src/portalGuard.ts`.** Excalidraw 0.18 keeps some UI state (notably the
  confirm dialog behind "Clear canvas") in a module-level jotai store shared by every
  `<Excalidraw>` on the page. Opening that dialog in one tab renders a modal portal on
  `<body>` for _every_ mounted editor, and confirming the wrong one would clear a hidden
  drawing. The guard finds each portal's owner by walking React's internal fiber
  (`__reactFiber$…`) up to the `.sketchbook-editor[data-doc-id]` wrapper and hides portals of
  inactive editors. It relies on React internals, so it can break on a React or Excalidraw
  upgrade. It fails safe: a portal whose owner can't be found stays visible, which is the
  behaviour without the guard.
- **Build-time patches to Excalidraw** in `electron.vite.config.ts` (CDN font fallback,
  embind `new Function`, subset-worker chunk). They throw and fail the build if Excalidraw's
  code changes shape.

Both are on the checklist in [upgrading-excalidraw.md](upgrading-excalidraw.md).

## Further reading

- [ADR index](adr/README.md) for the reasoning behind each of these choices.
- [offline.md](offline.md) for the `app://` protocol, fonts and the network block.
