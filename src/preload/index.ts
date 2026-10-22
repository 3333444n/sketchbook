import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type DocPayload, type MenuAction, type SketchbookAPI } from '../shared/ipc'

const api: SketchbookAPI = {
  getInitialDoc: () => ipcRenderer.invoke(IPC.getInitialDoc),
  onLoadDoc: (cb) => {
    const listener = (_e: IpcRendererEvent, doc: DocPayload): void => cb(doc)
    ipcRenderer.on(IPC.loadDoc, listener)
    return () => ipcRenderer.removeListener(IPC.loadDoc, listener)
  },
  save: (contents, opts) => ipcRenderer.invoke(IPC.save, contents, { saveAs: !!opts.saveAs }),
  open: () => ipcRenderer.send(IPC.open),
  newWindow: () => ipcRenderer.send(IPC.newWindow),
  setDirty: (dirty) => ipcRenderer.send(IPC.setDirty, !!dirty),
  setEmpty: (empty) => ipcRenderer.send(IPC.setEmpty, !!empty),
  autosave: (contents) => ipcRenderer.send(IPC.autosave, contents),
  onMenu: (cb) => {
    const listener = (_e: IpcRendererEvent, action: MenuAction): void => cb(action)
    ipcRenderer.on(IPC.menu, listener)
    return () => ipcRenderer.removeListener(IPC.menu, listener)
  },
  openExternal: (url) => ipcRenderer.send(IPC.openExternal, url)
}

contextBridge.exposeInMainWorld('sketchbook', api)
