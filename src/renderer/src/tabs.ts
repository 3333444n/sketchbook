// Types shared by the window shell (App) and its per-tab editors.

import type { ExcalidrawImperativeAPI, LibraryItems } from '@excalidraw/excalidraw/types'
import type { MenuAction } from '../../shared/ipc'
import type { ThemePreference } from './theme'

/** Viewport worth restoring when an evicted tab is mounted again. */
export type EditorView = { scrollX: number; scrollY: number; zoom: number }

/**
 * Per-document state that is not in the file contents. Set when an editor is
 * evicted (unmounted to save memory) so that remounting it from the snapshot
 * behaves as if it had never left.
 */
export type EditorInit = {
  /** The document had unsaved changes: it stays dirty until saved. */
  dirty: boolean
  /** The original file failed to load: never overwrite it in place. */
  forceSaveAs: boolean
  view?: EditorView
}

/** An editor's scene serialized for eviction (`serializeAsJSON(..., 'local')`). */
export type EditorSnapshot = EditorInit & { contents: string }

/** What a mounted editor exposes to App. */
export type EditorHandle = {
  /** Resolves true when the document was written to disk. */
  save: (opts: { saveAs: boolean }) => Promise<boolean>
  /** null while the scene is still loading (nothing to snapshot yet). */
  snapshot: () => EditorSnapshot | null
  menu: (action: MenuAction) => void
  /** Move keyboard focus into this editor. */
  focus: () => void
  getApi: () => ExcalidrawImperativeAPI | null
}

/**
 * Window-level callbacks handed to every editor. App keeps this object's identity
 * stable for its whole lifetime so hidden editors never re-render because of it.
 */
export type EditorEvents = {
  register: (docId: string, handle: EditorHandle | null) => void
  onDirtyChange: (docId: string, dirty: boolean) => void
  onPathChange: (docId: string, path: string) => void
  onBackgroundChange: (docId: string, color: string) => void
  onLibraryChange: (docId: string, items: LibraryItems) => void
  getInitialLibrary: () => LibraryItems
  onThemePreferenceChange: (pref: ThemePreference) => void
}
