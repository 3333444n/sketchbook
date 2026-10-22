// Thin adapter over `window.sketchbook` (the preload IPC API).
//
// Every per-document call already takes the docId, even though today's contract is
// one document per window and ignores it. When the contract gains per-tab calls,
// only this file needs to change.

import type { DocPayload, MenuAction, SaveResult } from '../../shared/ipc'

const api = (): Window['sketchbook'] => window.sketchbook

export const bridge = {
  // ---- window-level ----
  getInitialDoc: (): Promise<DocPayload> => api().getInitialDoc(),
  onLoadDoc: (cb: (doc: DocPayload) => void): (() => void) => api().onLoadDoc(cb),
  onMenu: (cb: (action: MenuAction) => void): (() => void) => api().onMenu(cb),
  open: (): void => api().open(),
  newWindow: (): void => api().newWindow(),
  openExternal: (url: string): void => api().openExternal(url),

  // ---- per-document ----
  save: (_docId: string, contents: string, opts: { saveAs: boolean }): Promise<SaveResult> =>
    api().save(contents, opts),
  setDirty: (_docId: string, dirty: boolean): void => api().setDirty(dirty),
  setEmpty: (_docId: string, empty: boolean): void => api().setEmpty(empty),
  autosave: (_docId: string, contents: string): void => api().autosave(contents)
}
