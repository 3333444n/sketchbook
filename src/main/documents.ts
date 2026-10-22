// Track A owns this file. Stub: one untitled window, IPC handlers are no-ops.
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { IPC, type DocPayload } from '../shared/ipc'
import { loadRenderer } from './protocol'

/** Secure defaults every document window must use. */
export function createDocWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    title: 'Untitled',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win.show())
  void loadRenderer(win)
  return win
}

export function initDocuments(): void {
  ipcMain.handle(IPC.getInitialDoc, (): DocPayload => ({
    docId: randomUUID(),
    path: null,
    contents: null
  }))
  ipcMain.handle(IPC.save, () => null)

  app.whenReady().then(() => {
    createDocWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createDocWindow()
    })
  })
}
