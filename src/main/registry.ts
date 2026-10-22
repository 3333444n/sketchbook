// Pure window/tab registry (no 'electron' import) so it can be unit tested.
//
// Docs are keyed by docId; windows by webContents.id. A window holds an ordered
// set of docIds (insertion order = the order main hands them to the renderer;
// the renderer owns the visible tab order).
import type { DocPayload } from '../shared/ipc'
import { windowTitle } from './fileio'

export type DocState = {
  docId: string
  /** webContents.id of the window hosting this doc. */
  winId: number
  path: string | null
  dirty: boolean
  empty: boolean
  /** User chose "Save" in a window-close/quit prompt; the close waits on this save. */
  pendingClose: boolean
  /** Latest known payload (returned by getInitialState, e.g. after a reload). */
  payload: DocPayload
}

export type WinState<W> = {
  id: number
  win: W
  docIds: Set<string>
  activeDocId: string | null
  /** Renderer has fetched its initial state (later docs must be pushed). */
  delivered: boolean
}

export type Chrome = {
  title: string
  representedFilename: string
  documentEdited: boolean
}

export class Registry<W> {
  readonly docs = new Map<string, DocState>()
  readonly windows = new Map<number, WinState<W>>()

  addWindow(id: number, win: W): WinState<W> {
    const w: WinState<W> = { id, win, docIds: new Set(), activeDocId: null, delivered: false }
    this.windows.set(id, w)
    return w
  }

  /** Remove a window and all its docs; returns the removed docs. */
  removeWindow(id: number): DocState[] {
    const w = this.windows.get(id)
    if (!w) return []
    const removed: DocState[] = []
    for (const docId of w.docIds) {
      const d = this.docs.get(docId)
      if (d) removed.push(d)
      this.docs.delete(docId)
    }
    this.windows.delete(id)
    return removed
  }

  /** Add a doc to a window (it becomes the window's active doc). */
  addDoc(winId: number, payload: DocPayload, opts?: { dirty?: boolean }): DocState {
    const w = this.windows.get(winId)
    if (!w) throw new Error(`unknown window ${winId}`)
    if (this.docs.has(payload.docId)) throw new Error(`duplicate docId ${payload.docId}`)
    const d: DocState = {
      docId: payload.docId,
      winId,
      path: payload.path,
      dirty: !!opts?.dirty,
      empty: payload.contents === null,
      pendingClose: false,
      payload
    }
    this.docs.set(d.docId, d)
    w.docIds.add(d.docId)
    w.activeDocId = d.docId
    return d
  }

  /** Forget a doc. Returns the window it lived in (undefined if unknown). */
  removeDoc(docId: string): WinState<W> | undefined {
    const d = this.docs.get(docId)
    if (!d) return undefined
    this.docs.delete(docId)
    const w = this.windows.get(d.winId)
    if (!w) return undefined
    w.docIds.delete(docId)
    if (w.activeDocId === docId) w.activeDocId = [...w.docIds].at(-1) ?? null
    return w
  }

  /** The doc, but only if it belongs to window `winId` (per-doc IPC guard). */
  docOf(winId: number, docId: unknown): DocState | undefined {
    if (typeof docId !== 'string') return undefined
    const d = this.docs.get(docId)
    return d && d.winId === winId ? d : undefined
  }

  docsOf(winId: number): DocState[] {
    const w = this.windows.get(winId)
    if (!w) return []
    return [...w.docIds].map((id) => this.docs.get(id)).filter((d): d is DocState => !!d)
  }

  findByPath(path: string): DocState | undefined {
    for (const d of this.docs.values()) if (d.path === path) return d
    return undefined
  }

  setActive(winId: number, docId: string): boolean {
    const w = this.windows.get(winId)
    if (!w || !w.docIds.has(docId)) return false
    w.activeDocId = docId
    return true
  }

  activeDoc(winId: number): DocState | undefined {
    const w = this.windows.get(winId)
    return w?.activeDocId ? this.docs.get(w.activeDocId) : undefined
  }

  /**
   * The doc an opened file may replace in place: the window's active doc when it
   * is untitled, clean, empty and not mid-close. Otherwise null (open a new tab).
   */
  reusableDoc(winId: number): DocState | null {
    const d = this.activeDoc(winId)
    if (d && d.path === null && !d.dirty && d.empty && !d.pendingClose) return d
    return null
  }

  anyDirty(winId?: number): boolean {
    const list = winId === undefined ? [...this.docs.values()] : this.docsOf(winId)
    return list.some((d) => d.dirty)
  }

  /** Window title / proxy icon follow the active doc; "edited" dot follows any dirty doc. */
  chrome(winId: number): Chrome {
    const active = this.activeDoc(winId)
    return {
      title: windowTitle(active?.path ?? null, !!active?.dirty),
      representedFilename: active?.path ?? '',
      documentEdited: this.anyDirty(winId)
    }
  }

  /** Payloads for getInitialState, in window order. */
  initialState(winId: number): { docs: DocPayload[]; activeDocId: string } | undefined {
    const w = this.windows.get(winId)
    if (!w) return undefined
    const docs = this.docsOf(winId).map((d) => d.payload)
    const activeDocId = w.activeDocId ?? docs[0]?.docId ?? ''
    return { docs, activeDocId }
  }
}
