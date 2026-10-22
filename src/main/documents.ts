// Track A: document windows, open/save, dirty state, close/quit prompts,
// crash recovery, Finder integration and external-link policy.
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { basename, dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { is } from '@electron-toolkit/utils'
import { IPC, type DocPayload, type MenuAction, type SaveResult } from '../shared/ipc'
import { loadRenderer } from './protocol'
import {
  atomicWrite,
  displayName,
  ensureExtension,
  isNativeScene,
  OPENABLE_EXTENSIONS,
  readDocContents,
  SCENE_EXTENSION,
  windowTitle
} from './fileio'
import { deleteJournal, scanJournals, writeJournal } from './recovery'
import { finderReady, initFinder } from './finder'
import { installDownloadHandler } from './downloads'

type DocEntry = {
  win: BrowserWindow
  docId: string
  path: string | null
  dirty: boolean
  empty: boolean
  /** User chose "Save" in the close prompt; destroy the window once saved. */
  pendingClose: boolean
  /** Payload returned by getInitialDoc (kept current so reloads show the latest doc). */
  payload: DocPayload
  /** Renderer has fetched its initial doc (so later docs must be pushed via loadDoc). */
  delivered: boolean
  /** A close prompt is currently showing for this window. */
  prompting: boolean
  /** Resolves the in-flight close attempt: true = window closed, false = cancelled. */
  closeResolver: ((closed: boolean) => void) | null
}

/** Registry keyed by webContents.id. */
const docs = new Map<number, DocEntry>()

let quitConfirmed = false
let quitInProgress = false

function recoveryDir(): string {
  return join(app.getPath('userData'), 'recovery')
}

function entryFor(sender: WebContents): DocEntry | undefined {
  return docs.get(sender.id)
}

function entryForWindow(win: BrowserWindow | null | undefined): DocEntry | undefined {
  if (!win || win.isDestroyed()) return undefined
  return docs.get(win.webContents.id)
}

/** webContents.id of the most recently focused (or created) document window. */
let lastFocusedId: number | null = null

/** The focused document window, falling back to the last one that had focus. */
function activeEntry(): DocEntry | undefined {
  const focused = entryForWindow(BrowserWindow.getFocusedWindow())
  if (focused) return focused
  return lastFocusedId !== null ? docs.get(lastFocusedId) : undefined
}

function findByPath(path: string): DocEntry | undefined {
  for (const e of docs.values()) if (e.path === path) return e
  return undefined
}

function updateWindowChrome(e: DocEntry): void {
  if (e.win.isDestroyed()) return
  e.win.setTitle(windowTitle(e.path, e.dirty))
  e.win.setDocumentEdited(e.dirty)
  e.win.setRepresentedFilename(e.path ?? '')
}

function focusWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ---------------------------------------------------------------------------
// Navigation / external links

function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'app:') return true
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (is.dev && dev && u.origin === new URL(dev).origin) return true
    // Fallback while the renderer is loaded via loadFile.
    if (u.protocol === 'file:' && u.pathname.endsWith('/renderer/index.html')) return true
  } catch {
    // fall through
  }
  return false
}

function isExternalAllowed(url: string): boolean {
  try {
    const p = new URL(url).protocol
    return p === 'https:' || p === 'http:' || p === 'mailto:'
  } catch {
    return false
  }
}

function openExternalSafe(url: string): void {
  if (typeof url === 'string' && isExternalAllowed(url)) void shell.openExternal(url)
}

// ---------------------------------------------------------------------------
// Windows

/** Secure defaults every document window must use. */
export function createDocWindow(
  payload?: Partial<DocPayload>,
  opts?: { dirty?: boolean }
): BrowserWindow {
  const anchor = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().at(-1)
  const pos: { x?: number; y?: number } = {}
  if (anchor && !anchor.isDestroyed()) {
    const [x, y] = anchor.getPosition()
    pos.x = x + 24
    pos.y = y + 24
  }

  const doc: DocPayload = {
    docId: payload?.docId ?? randomUUID(),
    path: payload?.path ?? null,
    contents: payload?.contents ?? null,
    ...(payload?.recovered ? { recovered: true } : {})
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    ...pos,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: windowTitle(doc.path, !!opts?.dirty),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  const entry: DocEntry = {
    win,
    docId: doc.docId,
    path: doc.path,
    dirty: !!opts?.dirty,
    empty: doc.contents === null,
    pendingClose: false,
    payload: doc,
    delivered: false,
    prompting: false,
    closeResolver: null
  }
  const wcId = win.webContents.id
  docs.set(wcId, entry)
  lastFocusedId = wcId
  updateWindowChrome(entry)
  win.on('focus', () => {
    lastFocusedId = wcId
  })

  // Keep our title instead of the page's <title>.
  win.on('page-title-updated', (e) => e.preventDefault())
  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return
    e.preventDefault()
    openExternalSafe(url)
  })
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())
  win.webContents.on('render-process-gone', () => {
    // A pending "Save and close" can never complete now; unblock close/quit.
    const cur = docs.get(wcId)
    if (cur) resolveClose(cur, false)
  })

  win.on('close', (e) => {
    const cur = docs.get(wcId)
    if (!cur || !cur.dirty || quitConfirmed) return
    e.preventDefault()
    void promptToClose(cur)
  })

  win.on('closed', () => {
    const cur = docs.get(wcId)
    docs.delete(wcId)
    if (lastFocusedId === wcId) lastFocusedId = null
    if (cur) {
      // Window closed deliberately (clean, saved or "Don't Save"): journal is obsolete.
      void deleteJournal(recoveryDir(), cur.docId).catch(() => {})
      cur.closeResolver?.(true)
      cur.closeResolver = null
    }
  })

  void loadRenderer(win)
  return win
}

/**
 * Show the "save changes?" prompt for a dirty window. Resolves true if the
 * window ends up closed, false if the user cancelled (or the save failed).
 */
function promptToClose(entry: DocEntry): Promise<boolean> {
  if (entry.prompting || entry.closeResolver) {
    // Already asking / waiting for a save; don't stack prompts.
    return new Promise((res) => {
      const prev = entry.closeResolver
      if (prev) {
        entry.closeResolver = (closed) => {
          prev(closed)
          res(closed)
        }
      } else res(false)
    })
  }
  const { win } = entry
  entry.prompting = true
  focusWindow(win)
  return dialog
    .showMessageBox(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: `Do you want to save the changes you made to "${displayName(entry.path)}"?`,
      detail: "Your changes will be lost if you don't save them."
    })
    .then(({ response }) => {
      entry.prompting = false
      if (win.isDestroyed()) return true
      if (response === 0) {
        return new Promise<boolean>((res) => {
          entry.pendingClose = true
          entry.closeResolver = res
          sendMenu(win, 'save-and-close')
        })
      }
      if (response === 1) {
        return new Promise<boolean>((res) => {
          entry.closeResolver = res
          entry.dirty = false
          void deleteJournal(recoveryDir(), entry.docId)
            .catch(() => {})
            .finally(() => {
              if (!win.isDestroyed()) win.destroy()
              else res(true)
            })
        })
      }
      return false
    })
    .catch(() => {
      entry.prompting = false
      return false
    })
}

function resolveClose(entry: DocEntry, closed: boolean): void {
  const r = entry.closeResolver
  entry.closeResolver = null
  entry.pendingClose = false
  r?.(closed)
}

function sendMenu(win: BrowserWindow, action: MenuAction): void {
  if (!win.isDestroyed()) win.webContents.send(IPC.menu, action)
}

/** Send a menu action to the focused document window (no-op if none). */
export function sendMenuToFocused(action: MenuAction): void {
  const e = activeEntry()
  if (e) sendMenu(e.win, action)
}

export function newUntitledWindow(): BrowserWindow {
  return createDocWindow()
}

// ---------------------------------------------------------------------------
// Open

/** Open each path: focus if already open, reuse a pristine focused window, else new window. */
export async function openPaths(paths: string[]): Promise<void> {
  for (const path of paths) {
    const existing = findByPath(path)
    if (existing) {
      focusWindow(existing.win)
      continue
    }
    let contents: string
    try {
      contents = await readDocContents(path)
    } catch (err) {
      dialog.showErrorBox(
        'Could not open file',
        `"${basename(path)}" could not be read.\n\n${(err as Error).message}`
      )
      continue
    }
    const focused = activeEntry()
    if (
      focused &&
      focused.path === null &&
      !focused.dirty &&
      focused.empty &&
      !focused.pendingClose
    ) {
      const payload: DocPayload = { docId: focused.docId, path, contents }
      focused.path = path
      focused.empty = false
      focused.payload = payload
      if (focused.delivered) focused.win.webContents.send(IPC.loadDoc, payload)
      updateWindowChrome(focused)
      focusWindow(focused.win)
    } else {
      createDocWindow({ path, contents })
    }
    app.addRecentDocument(path)
  }
}

export async function showOpenDialog(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow()
  const opts: Electron.OpenDialogOptions = {
    properties: ['openFile', 'multiSelections'],
    defaultPath: app.getPath('documents'),
    filters: [
      { name: 'Excalidraw', extensions: [...OPENABLE_EXTENSIONS] },
      { name: 'Excalidraw scene', extensions: ['excalidraw'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'Image with embedded scene', extensions: ['png', 'svg'] }
    ]
  }
  const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || res.filePaths.length === 0) return
  await openPaths(res.filePaths)
}

// ---------------------------------------------------------------------------
// Save

async function handleSave(entry: DocEntry, contents: string, saveAs: boolean): Promise<SaveResult> {
  const { win } = entry
  let target: string

  // Only ever write to a path main already holds or one from main's own dialog.
  if (!saveAs && entry.path && isNativeScene(entry.path)) {
    target = entry.path
  } else {
    const defaultPath = entry.path
      ? join(dirname(entry.path), displayName(entry.path) + SCENE_EXTENSION)
      : join(app.getPath('documents'), 'Untitled' + SCENE_EXTENSION)
    const opts: Electron.SaveDialogOptions = {
      defaultPath,
      filters: [{ name: 'Excalidraw', extensions: ['excalidraw'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    }
    const res = win.isDestroyed()
      ? await dialog.showSaveDialog(opts)
      : await dialog.showSaveDialog(win, opts)
    if (res.canceled || !res.filePath) {
      resolveClose(entry, false)
      return null
    }
    target = ensureExtension(res.filePath, SCENE_EXTENSION)
  }

  try {
    await atomicWrite(target, contents)
  } catch (err) {
    dialog.showErrorBox(
      'Could not save',
      `"${basename(target)}" could not be saved.\n\n${(err as Error).message}`
    )
    resolveClose(entry, false)
    return null
  }

  entry.path = target
  entry.dirty = false
  entry.empty = false
  entry.payload = { docId: entry.docId, path: target, contents }
  app.addRecentDocument(target)
  updateWindowChrome(entry)
  await deleteJournal(recoveryDir(), entry.docId).catch(() => {})

  if (entry.pendingClose) {
    entry.pendingClose = false
    // closeResolver fires from the 'closed' handler once the window is gone.
    // Defer so the invoke reply is delivered before the renderer goes away.
    setImmediate(() => {
      if (!win.isDestroyed()) win.destroy()
    })
  }
  return { path: target }
}

// ---------------------------------------------------------------------------
// Quit

async function confirmQuit(): Promise<void> {
  quitInProgress = true
  try {
    const dirty = [...docs.values()].filter((e) => e.dirty)
    for (const e of dirty) {
      if (e.win.isDestroyed() || !docs.has(e.win.webContents.id) || !e.dirty) continue
      const closed = await promptToClose(e)
      if (!closed) return // user cancelled: abort quit
    }
    quitConfirmed = true
    app.quit()
  } finally {
    quitInProgress = false
  }
}

// ---------------------------------------------------------------------------
// IPC

function onIpc(
  channel: string,
  fn: (entry: DocEntry, e: IpcMainEvent, ...args: unknown[]) => void
): void {
  ipcMain.on(channel, (e, ...args) => {
    const entry = entryFor(e.sender)
    if (!entry) return
    fn(entry, e, ...args)
  })
}

function registerIpc(): void {
  ipcMain.handle(IPC.getInitialDoc, (e: IpcMainInvokeEvent): DocPayload => {
    const entry = entryFor(e.sender)
    if (!entry) throw new Error('unknown window')
    entry.delivered = true
    return entry.payload
  })

  ipcMain.handle(IPC.save, (e: IpcMainInvokeEvent, contents: unknown, opts: unknown) => {
    const entry = entryFor(e.sender)
    if (!entry) throw new Error('unknown window')
    if (typeof contents !== 'string') throw new Error('contents must be a string')
    const saveAs = !!(opts && typeof opts === 'object' && (opts as { saveAs?: unknown }).saveAs)
    return handleSave(entry, contents, saveAs)
  })

  onIpc(IPC.open, () => void showOpenDialog())
  onIpc(IPC.newWindow, () => void newUntitledWindow())

  onIpc(IPC.setDirty, (entry, _e, dirty) => {
    entry.dirty = !!dirty
    updateWindowChrome(entry)
  })

  onIpc(IPC.setEmpty, (entry, _e, empty) => {
    entry.empty = !!empty
  })

  onIpc(IPC.autosave, (entry, _e, contents) => {
    if (typeof contents !== 'string') return
    // A clean document needs no journal (avoids resurrecting a just-saved doc).
    if (!entry.dirty) return
    void writeJournal(recoveryDir(), {
      docId: entry.docId,
      path: entry.path,
      contents
    }).catch((err) => console.error('[recovery] write failed:', err))
  })

  onIpc(IPC.openExternal, (_entry, _e, url) => {
    if (typeof url === 'string') openExternalSafe(url)
  })
}

// ---------------------------------------------------------------------------
// Startup

async function startup(): Promise<void> {
  installDownloadHandler()

  let opened = 0
  try {
    const journals = await scanJournals(recoveryDir())
    for (const j of journals) {
      createDocWindow(
        { docId: j.docId, path: j.path, contents: j.contents, recovered: true },
        { dirty: true }
      )
      opened++
    }
  } catch (err) {
    console.error('[recovery] scan failed:', err)
  }

  const queued = finderReady((paths) => void openPaths(paths))
  if (queued.length) {
    await openPaths(queued)
    opened += queued.length
  }

  if (opened === 0 || docs.size === 0) createDocWindow()
}

export function initDocuments(): void {
  const primary = initFinder(() => {
    const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (w) focusWindow(w)
    else if (app.isReady()) newUntitledWindow()
  })
  if (!primary) return

  registerIpc()

  app.on('before-quit', (e) => {
    if (quitConfirmed) return
    const anyDirty = [...docs.values()].some((d) => d.dirty)
    if (!anyDirty) {
      quitConfirmed = true
      return
    }
    e.preventDefault()
    if (!quitInProgress) void confirmQuit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (app.isReady() && BrowserWindow.getAllWindows().length === 0) newUntitledWindow()
  })

  app.whenReady().then(() => {
    void startup()
  })
}
