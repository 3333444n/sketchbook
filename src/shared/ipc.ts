// IPC contract shared by main, preload and renderer (v2: tabs).
// Owned by the integrator: tracks must not change this file without coordination.
//
// Model: each window hosts an ordered set of tabs; each tab is one document (docId).
// Main is the source of truth for which docs live in which window, their paths and
// dirty state. The renderer owns tab order, the active tab and the tab-strip UI,
// and reports the active tab back to main.

/** A document as handed to a renderer window. */
export type DocPayload = {
  /** Stable id for the document (also the recovery journal key). */
  docId: string
  /** Absolute path on disk, or null for an untitled drawing. */
  path: string | null
  /**
   * Raw file contents, or null for a new empty drawing.
   * `.png` files arrive as a `data:image/png;base64,...` string; everything else
   * (.excalidraw, .json, .svg) is UTF-8 text.
   */
  contents: string | null
  /** True when restored from the recovery journal after a crash. */
  recovered?: boolean
  /** Name given to an untitled doc via rename (also the default Save name). */
  title?: string
}

/** Actions the native menu sends to the window; they apply to the active tab. */
export type MenuAction =
  | 'save'
  | 'save-as'
  | 'export-image'
  | 'mermaid'
  /** ⌘W: run the close-tab flow for the active tab. */
  | 'close-tab'
  /** ⌃Tab / ⇧⌘] */
  | 'next-tab'
  /** ⌃⇧Tab / ⇧⌘[ */
  | 'prev-tab'

export type SaveResult = { path: string } | null

/**
 * Result of renaming a doc: its (possibly new) path and display title.
 * null if the name was invalid or the rename failed (main already told the user).
 */
export type RenameResult = { path: string | null; title: string } | null

/**
 * Result of asking main to close a tab:
 * - 'close'  → remove the tab now, then call `docClosed`.
 * - 'save'   → user chose Save: save the doc; if it succeeds remove the tab and call
 *              `docClosed`, otherwise keep the tab.
 * - 'cancel' → keep the tab.
 */
export type CloseDecision = 'close' | 'save' | 'cancel'

export type InitialState = {
  docs: DocPayload[]
  /** Which of `docs` to show first. */
  activeDocId: string
  /** Window is in native full screen (traffic lights hidden → no left inset needed). */
  fullScreen: boolean
}

/** Exposed on `window.sketchbook` by the preload script. */
export interface SketchbookAPI {
  // ---- window-level ----------------------------------------------------------
  /** The tabs this window should show on startup (always at least one). */
  getInitialState(): Promise<InitialState>
  /**
   * Main adds documents to this window as new tabs and asks to activate `activeDocId`.
   * If a payload's docId matches an existing tab, REPLACE that tab's document
   * (main does this when opening a file into a pristine untitled tab).
   */
  onOpenDocs(cb: (docs: DocPayload[], activeDocId: string) => void): () => void
  /** Main asks to switch to an existing tab (e.g. file already open, or close prompt). */
  onActivateDoc(cb: (docId: string) => void): () => void
  /**
   * Main needs this doc saved before closing its window / quitting (user chose
   * Save in main's prompt). Save it (not Save As); main finishes the close on success.
   */
  onSaveAndClose(cb: (docId: string) => void): () => void
  /** Native menu actions for the active tab. */
  onMenu(cb: (action: MenuAction) => void): () => void
  /** Native full-screen changes (to adjust the title-bar inset). */
  onFullScreenChange(cb: (fullScreen: boolean) => void): () => void
  /** Show the native Open dialog (main opens results as tabs in this window). */
  open(): void
  /** Ask main for a new untitled tab in this window (arrives via onOpenDocs). */
  newTab(): void
  /** Ask main to open a new window with one untitled tab. */
  newWindow(): void
  /** Open an http(s)/mailto URL in the system browser. */
  openExternal(url: string): void

  // ---- per-document ----------------------------------------------------------
  /** Tell main which tab is active (drives window title, proxy icon, menu target). */
  setActiveDoc(docId: string): void
  /**
   * Save the doc. Main picks the target: the doc's current path, or a native Save
   * dialog when there is none or `saveAs` is true. Resolves null if cancelled/failed.
   */
  save(docId: string, contents: string, opts: { saveAs: boolean }): Promise<SaveResult>
  /** Unsaved-changes state. */
  setDirty(docId: string, dirty: boolean): void
  /** Whether the canvas has no elements (lets main reuse a pristine tab). */
  setEmpty(docId: string, empty: boolean): void
  /** Write the current scene to the crash-recovery journal (renderer debounces). */
  autosave(docId: string, contents: string): void
  /**
   * Rename the doc. Saved docs: the file on disk is renamed (same folder and
   * extension). Untitled docs: the name becomes the tab title and default Save name.
   */
  renameDoc(docId: string, name: string): Promise<RenameResult>
  /** Ask main whether this tab may close (main shows the save prompt if dirty). */
  requestCloseDoc(docId: string): Promise<CloseDecision>
  /**
   * The tab is gone from the UI. Main forgets the doc and deletes its journal;
   * if it was the window's last tab, main closes the window.
   */
  docClosed(docId: string): void
}

export const IPC = {
  getInitialState: 'win:get-initial-state',
  openDocs: 'win:open-docs',
  activateDoc: 'win:activate-doc',
  saveAndClose: 'win:save-and-close',
  menu: 'win:menu-action',
  fullScreen: 'win:full-screen',
  open: 'win:open',
  newTab: 'win:new-tab',
  newWindow: 'win:new-window',
  openExternal: 'shell:open-external',

  setActiveDoc: 'doc:set-active',
  save: 'doc:save',
  setDirty: 'doc:set-dirty',
  setEmpty: 'doc:set-empty',
  autosave: 'doc:autosave',
  renameDoc: 'doc:rename',
  requestCloseDoc: 'doc:request-close',
  docClosed: 'doc:closed'
} as const
