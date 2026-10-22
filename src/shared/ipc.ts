// IPC contract shared by main, preload and renderer.
// Owned by the integrator: tracks must not change this file without coordination.

/** A document as handed to a renderer window. */
export type DocPayload = {
  /** Stable id for the window's document (also the recovery journal key). */
  docId: string
  /** Absolute path on disk, or null for an untitled drawing. */
  path: string | null
  /** Raw file contents (.excalidraw JSON), or null for a new empty drawing. */
  contents: string | null
  /** True when restored from the recovery journal after a crash. */
  recovered?: boolean
}

/** Actions the native menu (or main process) asks the renderer to perform. */
export type MenuAction =
  'new' | 'open' | 'save' | 'save-as' | 'save-and-close' | 'export-image' | 'mermaid'

export type SaveResult = { path: string } | null

/** Exposed on `window.sketchbook` by the preload script. */
export interface SketchbookAPI {
  /** The document this window should show on startup. */
  getInitialDoc(): Promise<DocPayload>
  /** Main pushes a document into this (empty) window. Returns an unsubscribe fn. */
  onLoadDoc(cb: (doc: DocPayload) => void): () => void
  /**
   * Save the scene. Main decides the target path: the window's current path,
   * or a native Save dialog when there is none or `saveAs` is true.
   * Resolves null if the user cancelled.
   */
  save(contents: string, opts: { saveAs: boolean }): Promise<SaveResult>
  /** Ask main to show the native Open dialog (main picks the window to open in). */
  open(): void
  /** Ask main to open a new untitled window. */
  newWindow(): void
  /** Unsaved-changes state, drives the close prompt and macOS edited dot. */
  setDirty(dirty: boolean): void
  /** Whether the canvas has no elements; lets main reuse a pristine window. */
  setEmpty(empty: boolean): void
  /** Write the current scene to the crash-recovery journal (debounced by renderer). */
  autosave(contents: string): void
  /** Subscribe to menu actions. Returns an unsubscribe fn. */
  onMenu(cb: (action: MenuAction) => void): () => void
  /** Open an http(s) URL in the system browser. */
  openExternal(url: string): void
}

export const IPC = {
  getInitialDoc: 'doc:get-initial',
  loadDoc: 'doc:load',
  save: 'doc:save',
  open: 'doc:open',
  newWindow: 'doc:new-window',
  setDirty: 'doc:set-dirty',
  setEmpty: 'doc:set-empty',
  autosave: 'doc:autosave',
  menu: 'menu:action',
  openExternal: 'shell:open-external'
} as const
