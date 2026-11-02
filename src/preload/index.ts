import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type SketchbookAPI } from '../shared/ipc'

/** Subscribe to a main → renderer channel; returns an unsubscribe fn. */
function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: SketchbookAPI = {
  // window-level
  getInitialState: () => ipcRenderer.invoke(IPC.getInitialState),
  onOpenDocs: (cb) => on(IPC.openDocs, cb),
  onActivateDoc: (cb) => on(IPC.activateDoc, cb),
  onSaveAndClose: (cb) => on(IPC.saveAndClose, cb),
  onMenu: (cb) => on(IPC.menu, cb),
  onFullScreenChange: (cb) => on(IPC.fullScreen, cb),
  open: () => ipcRenderer.send(IPC.open),
  newTab: () => ipcRenderer.send(IPC.newTab),
  newWindow: () => ipcRenderer.send(IPC.newWindow),
  openExternal: (url) => ipcRenderer.send(IPC.openExternal, url),
  onAgentRequest: (cb) => on(IPC.agentRequest, cb),
  agentResponse: (res) => ipcRenderer.send(IPC.agentResponse, res),

  // per-document
  setActiveDoc: (docId) => ipcRenderer.send(IPC.setActiveDoc, docId),
  save: (docId, contents, opts) =>
    ipcRenderer.invoke(IPC.save, docId, contents, { saveAs: !!opts.saveAs }),
  setDirty: (docId, dirty) => ipcRenderer.send(IPC.setDirty, docId, !!dirty),
  setEmpty: (docId, empty) => ipcRenderer.send(IPC.setEmpty, docId, !!empty),
  autosave: (docId, contents) => ipcRenderer.send(IPC.autosave, docId, contents),
  renameDoc: (docId, name) => ipcRenderer.invoke(IPC.renameDoc, docId, name),
  requestCloseDoc: (docId) => ipcRenderer.invoke(IPC.requestCloseDoc, docId),
  docClosed: (docId) => ipcRenderer.send(IPC.docClosed, docId)
}

contextBridge.exposeInMainWorld('sketchbook', api)
