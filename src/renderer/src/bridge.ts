// Thin adapter over `window.sketchbook` (the preload IPC API, contract v2: tabs).
// The rest of the renderer talks to main only through this object.

import type {
  AgentRequest,
  AgentResponse,
  CloseDecision,
  DocPayload,
  InitialState,
  MenuAction,
  RenameResult,
  SaveResult
} from '../../shared/ipc'

const api = (): Window['sketchbook'] => window.sketchbook

type Unsubscribe = () => void

export const bridge = {
  // ---- window-level ----
  getInitialState: (): Promise<InitialState> => api().getInitialState(),
  onOpenDocs: (cb: (docs: DocPayload[], activeDocId: string) => void): Unsubscribe =>
    api().onOpenDocs(cb),
  onActivateDoc: (cb: (docId: string) => void): Unsubscribe => api().onActivateDoc(cb),
  onSaveAndClose: (cb: (docId: string) => void): Unsubscribe => api().onSaveAndClose(cb),
  onMenu: (cb: (action: MenuAction) => void): Unsubscribe => api().onMenu(cb),
  onFullScreenChange: (cb: (fullScreen: boolean) => void): Unsubscribe =>
    api().onFullScreenChange(cb),
  open: (): void => api().open(),
  newTab: (): void => api().newTab(),
  newWindow: (): void => api().newWindow(),
  openExternal: (url: string): void => api().openExternal(url),
  onAgentRequest: (cb: (req: AgentRequest) => void): Unsubscribe => api().onAgentRequest(cb),
  agentResponse: (res: AgentResponse): void => api().agentResponse(res),

  // ---- per-document ----
  setActiveDoc: (docId: string): void => api().setActiveDoc(docId),
  save: (docId: string, contents: string, opts: { saveAs: boolean }): Promise<SaveResult> =>
    api().save(docId, contents, opts),
  setDirty: (docId: string, dirty: boolean): void => api().setDirty(docId, dirty),
  setEmpty: (docId: string, empty: boolean): void => api().setEmpty(docId, empty),
  autosave: (docId: string, contents: string): void => api().autosave(docId, contents),
  renameDoc: (docId: string, name: string): Promise<RenameResult> => api().renameDoc(docId, name),
  requestCloseDoc: (docId: string): Promise<CloseDecision> => api().requestCloseDoc(docId),
  docClosed: (docId: string): void => api().docClosed(docId)
}
