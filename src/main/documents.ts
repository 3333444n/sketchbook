// Track A: document windows and tabs, open/save, dirty state, close/quit prompts,
// crash recovery, Finder integration and external-link policy.
//
// Each window hosts several docs (tabs). Main owns which docs live in which window,
// their paths and dirty state (see registry.ts); the renderer owns tab order and
// reports the active tab.
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { basename, dirname, join } from 'path'
import { randomUUID } from 'crypto'
import {
  IPC,
  type CloseDecision,
  type DocPayload,
  type InitialState,
  type MenuAction,
  type SaveResult
} from '../shared/ipc'
import { TRAFFIC_LIGHT_POSITION } from '../shared/chrome'
import { isAppUrl, loadRenderer } from './protocol'
import {
  atomicWrite,
  displayName,
  ensureExtension,
  isNativeScene,
  OPENABLE_EXTENSIONS,
  readDocContents,
  SCENE_EXTENSION
} from './fileio'
import { deleteJournal, scanJournals, writeJournal } from './recovery'
import { finderReady, initFinder } from './finder'
import { installDownloadHandler } from './downloads'
import { Registry, type DocState, type WinState } from './registry'

/** Main-only per-window state (not in the pure registry). */
type WinExtra = {
  /** In-flight window close flow (prompts for each dirty doc). */
  closing: Promise<boolean> | null
  /** Close was approved: let the native close proceed without prompting. */
  closeApproved: boolean
}

const reg = new Registry<BrowserWindow>()
const extra = new Map<number, WinExtra>()
/** docId → resolver for a "Save" chosen in a window-close/quit prompt. */
const saveWaiters = new Map<string, (saved: boolean) => void>()

let quitConfirmed = false
let quitInProgress = false

function recoveryDir(): string {
  return join(app.getPath('userData'), 'recovery')
}

function dropJournal(docId: string): Promise<void> {
  return deleteJournal(recoveryDir(), docId).catch(() => {})
}

/** webContents.id of the most recently focused (or created) document window. */
let lastFocusedId: number | null = null

function winStateOf(win: BrowserWindow | null | undefined): WinState<BrowserWindow> | undefined {
  if (!win || win.isDestroyed()) return undefined
  return reg.windows.get(win.webContents.id)
}

/** The focused document window, falling back to the last one that had focus. */
function activeWin(): WinState<BrowserWindow> | undefined {
  const focused = winStateOf(BrowserWindow.getFocusedWindow())
  if (focused) return focused
  const last = lastFocusedId !== null ? reg.windows.get(lastFocusedId) : undefined
  if (last && !last.win.isDestroyed()) return last
  return undefined
}

function updateWindowChrome(winId: number): void {
  const w = reg.windows.get(winId)
  if (!w || w.win.isDestroyed()) return
  const c = reg.chrome(winId)
  w.win.setTitle(c.title)
  w.win.setDocumentEdited(c.documentEdited)
  w.win.setRepresentedFilename(c.representedFilename)
}

function focusWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function send(w: WinState<BrowserWindow>, channel: string, ...args: unknown[]): void {
  if (!w.win.isDestroyed()) w.win.webContents.send(channel, ...args)
}

// ---------------------------------------------------------------------------
// Navigation / external links

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

function newPayload(p?: Partial<DocPayload>): DocPayload {
  return {
    docId: p?.docId ?? randomUUID(),
    path: p?.path ?? null,
    contents: p?.contents ?? null,
    ...(p?.recovered ? { recovered: true } : {})
  }
}

/**
 * Create a document window hosting `initial` docs as tabs (one untitled tab when
 * empty). The last doc is active. Secure defaults every window must use.
 */
export function createDocWindow(
  initial: { payload: DocPayload; dirty?: boolean }[] = []
): BrowserWindow {
  const anchor = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().at(-1)
  const pos: { x?: number; y?: number } = {}
  if (anchor && !anchor.isDestroyed()) {
    const [x, y] = anchor.getPosition()
    pos.x = x + 24
    pos.y = y + 24
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    ...pos,
    minWidth: 480,
    minHeight: 360,
    show: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121212' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  const wcId = win.webContents.id
  reg.addWindow(wcId, win)
  extra.set(wcId, { closing: null, closeApproved: false })
  const docs = initial.length ? initial : [{ payload: newPayload() }]
  for (const d of docs) reg.addDoc(wcId, d.payload, { dirty: d.dirty })
  lastFocusedId = wcId
  updateWindowChrome(wcId)

  win.on('focus', () => {
    lastFocusedId = wcId
  })
  // Keep our title instead of the page's <title>.
  win.on('page-title-updated', (e) => e.preventDefault())
  win.once('ready-to-show', () => win.show())
  win.on('enter-full-screen', () => win.webContents.send(IPC.fullScreen, true))
  win.on('leave-full-screen', () => win.webContents.send(IPC.fullScreen, false))

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
    for (const d of reg.docsOf(wcId)) resolveSaveWaiter(d, false)
  })

  win.on('close', (e) => {
    const x = extra.get(wcId)
    if (quitConfirmed || !x || x.closeApproved || !reg.anyDirty(wcId)) return
    e.preventDefault()
    void closeWindowFlow(wcId)
  })

  win.on('closed', () => {
    // Window closed deliberately (clean, saved or "Don't Save"): journals are obsolete.
    for (const d of reg.removeWindow(wcId)) {
      resolveSaveWaiter(d, false)
      void dropJournal(d.docId)
    }
    extra.delete(wcId)
    if (lastFocusedId === wcId) lastFocusedId = null
  })

  void loadRenderer(win)
  return win
}

/** Add docs to an existing window as tabs (the last becomes active) and push them. */
function addDocsToWindow(
  w: WinState<BrowserWindow>,
  items: { payload: DocPayload; dirty?: boolean }[]
): void {
  if (!items.length) return
  for (const it of items) reg.addDoc(w.id, it.payload, { dirty: it.dirty })
  const activeDocId = items[items.length - 1].payload.docId
  if (w.delivered)
    send(
      w,
      IPC.openDocs,
      items.map((i) => i.payload),
      activeDocId
    )
  updateWindowChrome(w.id)
}

export function newUntitledWindow(): BrowserWindow {
  return createDocWindow()
}

/** New untitled tab in the focused window (or a new window when there is none). */
export function newTab(target?: WinState<BrowserWindow>): void {
  const w = target ?? activeWin()
  if (!w) {
    newUntitledWindow()
    return
  }
  addDocsToWindow(w, [{ payload: newPayload() }])
  focusWindow(w.win)
}

// ---------------------------------------------------------------------------
// Close flows

function showSavePrompt(win: BrowserWindow, d: DocState): Promise<number> {
  focusWindow(win)
  return dialog
    .showMessageBox(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: `Do you want to save the changes you made to "${displayName(d.path)}"?`,
      detail: "Your changes will be lost if you don't save them."
    })
    .then((r) => r.response)
    .catch(() => 2)
}

function resolveSaveWaiter(d: DocState, saved: boolean): void {
  d.pendingClose = false
  const r = saveWaiters.get(d.docId)
  saveWaiters.delete(d.docId)
  r?.(saved)
}

/**
 * Prompt for each dirty doc in a window, then destroy it. Resolves true if the
 * window ends up closed, false if the user cancelled or a save failed.
 */
function closeWindowFlow(winId: number): Promise<boolean> {
  const x = extra.get(winId)
  if (!x) return Promise.resolve(true)
  if (x.closing) return x.closing
  const run = async (): Promise<boolean> => {
    const w = reg.windows.get(winId)
    if (!w) return true
    for (const d of reg.docsOf(winId)) {
      if (w.win.isDestroyed()) return true
      // Re-check: the doc may have been closed or saved while a prompt was up.
      if (!d.dirty || reg.docOf(winId, d.docId) !== d) continue
      send(w, IPC.activateDoc, d.docId)
      reg.setActive(winId, d.docId)
      updateWindowChrome(winId)
      const response = await showSavePrompt(w.win, d)
      if (w.win.isDestroyed()) return true
      if (response === 0) {
        const saved = await new Promise<boolean>((res) => {
          d.pendingClose = true
          saveWaiters.set(d.docId, res)
          send(w, IPC.saveAndClose, d.docId)
        })
        if (!saved) return false
      } else if (response === 1) {
        // Leave d.dirty alone: if a later prompt is cancelled the tab stays edited.
        await dropJournal(d.docId)
      } else {
        return false
      }
    }
    x.closeApproved = true
    // Defer so a just-resolved save's invoke reply reaches the renderer first.
    await new Promise<void>((res) => setImmediate(res))
    if (!w.win.isDestroyed()) w.win.destroy()
    return true
  }
  x.closing = run().finally(() => {
    x.closing = null
  })
  return x.closing
}

async function requestCloseDoc(w: WinState<BrowserWindow>, d: DocState): Promise<CloseDecision> {
  if (!d.dirty) return 'close'
  if (extra.get(w.id)?.closing) return 'cancel' // a window-close prompt is already up
  const response = await showSavePrompt(w.win, d)
  if (response === 0) return 'save'
  if (response === 1) {
    d.dirty = false
    await dropJournal(d.docId)
    updateWindowChrome(w.id)
    return 'close'
  }
  return 'cancel'
}

function docClosed(w: WinState<BrowserWindow>, d: DocState): void {
  resolveSaveWaiter(d, false)
  reg.removeDoc(d.docId)
  void dropJournal(d.docId)
  if (w.docIds.size === 0) {
    const x = extra.get(w.id)
    if (x) x.closeApproved = true
    if (!w.win.isDestroyed()) w.win.destroy()
    return
  }
  updateWindowChrome(w.id)
}

function sendMenu(win: BrowserWindow, action: MenuAction): void {
  if (!win.isDestroyed()) win.webContents.send(IPC.menu, action)
}

/** Send a menu action to the focused document window (no-op if none). */
export function sendMenuToFocused(action: MenuAction): void {
  const w = activeWin()
  if (w) sendMenu(w.win, action)
}

// ---------------------------------------------------------------------------
// Open

/**
 * Open each path: activate it if already open anywhere; else open it in the
 * focused (or most recent) window, replacing a pristine untitled active tab or
 * adding a new tab; else a new window.
 */
export async function openPaths(paths: string[], target?: WinState<BrowserWindow>): Promise<void> {
  for (const path of paths) {
    const existing = reg.findByPath(path)
    if (existing) {
      const w = reg.windows.get(existing.winId)
      if (w) {
        reg.setActive(w.id, existing.docId)
        send(w, IPC.activateDoc, existing.docId)
        updateWindowChrome(w.id)
        focusWindow(w.win)
      }
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
    // The file may have been opened while we were reading it.
    if (reg.findByPath(path)) continue

    const w = target && reg.windows.has(target.id) ? target : activeWin()
    if (!w) {
      createDocWindow([{ payload: newPayload({ path, contents }) }])
    } else {
      const reuse = reg.reusableDoc(w.id)
      if (reuse) {
        const payload: DocPayload = { docId: reuse.docId, path, contents }
        reuse.path = path
        reuse.empty = false
        reuse.payload = payload
        if (w.delivered) send(w, IPC.openDocs, [payload], payload.docId)
        updateWindowChrome(w.id)
      } else {
        addDocsToWindow(w, [{ payload: newPayload({ path, contents }) }])
      }
      focusWindow(w.win)
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

async function handleSave(
  w: WinState<BrowserWindow>,
  d: DocState,
  contents: string,
  saveAs: boolean
): Promise<SaveResult> {
  const { win } = w
  let target: string

  // Only ever write to a path main already holds or one from main's own dialog.
  if (!saveAs && d.path && isNativeScene(d.path)) {
    target = d.path
  } else {
    const defaultPath = d.path
      ? join(dirname(d.path), displayName(d.path) + SCENE_EXTENSION)
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
      resolveSaveWaiter(d, false)
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
    resolveSaveWaiter(d, false)
    return null
  }

  d.path = target
  d.dirty = false
  d.empty = false
  d.payload = { docId: d.docId, path: target, contents }
  app.addRecentDocument(target)
  updateWindowChrome(w.id)
  await dropJournal(d.docId)

  // Continue a window-close/quit that was waiting on this save.
  if (d.pendingClose) resolveSaveWaiter(d, true)
  return { path: target }
}

// ---------------------------------------------------------------------------
// Quit

async function confirmQuit(): Promise<void> {
  quitInProgress = true
  try {
    for (const w of [...reg.windows.values()]) {
      if (w.win.isDestroyed() || !reg.windows.has(w.id) || !reg.anyDirty(w.id)) continue
      const closed = await closeWindowFlow(w.id)
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

/** Window-level message from a known document window. */
function onWin(
  channel: string,
  fn: (w: WinState<BrowserWindow>, e: IpcMainEvent, ...args: unknown[]) => void
): void {
  ipcMain.on(channel, (e, ...args) => {
    const w = reg.windows.get(e.sender.id)
    if (w) fn(w, e, ...args)
  })
}

/** Per-doc message: ignored unless the doc belongs to the sender's window. */
function onDoc(
  channel: string,
  fn: (w: WinState<BrowserWindow>, d: DocState, ...args: unknown[]) => void
): void {
  ipcMain.on(channel, (e, docId, ...args) => {
    const w = reg.windows.get(e.sender.id)
    const d = w && reg.docOf(w.id, docId)
    if (w && d) fn(w, d, ...args)
  })
}

function registerIpc(): void {
  ipcMain.handle(IPC.getInitialState, (e: IpcMainInvokeEvent): InitialState => {
    const w = reg.windows.get(e.sender.id)
    const init = w && reg.initialState(w.id)
    if (!w || !init) throw new Error('unknown window')
    w.delivered = true
    return { ...init, fullScreen: w.win.isFullScreen() }
  })

  ipcMain.handle(
    IPC.save,
    (e: IpcMainInvokeEvent, docId: unknown, contents: unknown, opts: unknown) => {
      const w = reg.windows.get(e.sender.id)
      const d = w && reg.docOf(w.id, docId)
      if (!w || !d) return null
      if (typeof contents !== 'string') throw new Error('contents must be a string')
      const saveAs = !!(opts && typeof opts === 'object' && (opts as { saveAs?: unknown }).saveAs)
      return handleSave(w, d, contents, saveAs)
    }
  )

  ipcMain.handle(
    IPC.requestCloseDoc,
    (e: IpcMainInvokeEvent, docId: unknown): Promise<CloseDecision> | CloseDecision => {
      const w = reg.windows.get(e.sender.id)
      const d = w && reg.docOf(w.id, docId)
      if (!w || !d) return 'cancel'
      return requestCloseDoc(w, d)
    }
  )

  onWin(IPC.open, () => void showOpenDialog())
  onWin(IPC.newTab, (w) => newTab(w))
  onWin(IPC.newWindow, () => void newUntitledWindow())
  onWin(IPC.openExternal, (_w, _e, url) => {
    if (typeof url === 'string') openExternalSafe(url)
  })

  onDoc(IPC.setActiveDoc, (w, d) => {
    reg.setActive(w.id, d.docId)
    updateWindowChrome(w.id)
  })

  onDoc(IPC.setDirty, (w, d, dirty) => {
    d.dirty = !!dirty
    updateWindowChrome(w.id)
  })

  onDoc(IPC.setEmpty, (_w, d, empty) => {
    d.empty = !!empty
  })

  onDoc(IPC.autosave, (_w, d, contents) => {
    if (typeof contents !== 'string') return
    // A clean document needs no journal (avoids resurrecting a just-saved doc).
    if (!d.dirty) return
    void writeJournal(recoveryDir(), { docId: d.docId, path: d.path, contents }).catch((err) =>
      console.error('[recovery] write failed:', err)
    )
  })

  onDoc(IPC.docClosed, (w, d) => docClosed(w, d))
}

// ---------------------------------------------------------------------------
// Startup

async function startup(): Promise<void> {
  installDownloadHandler()

  // All recovered journals go into one window as (dirty) tabs.
  let recoveryWin: WinState<BrowserWindow> | undefined
  try {
    const journals = await scanJournals(recoveryDir())
    if (journals.length) {
      const win = createDocWindow(
        journals.map((j) => ({
          payload: newPayload({
            docId: j.docId,
            path: j.path,
            contents: j.contents,
            recovered: true
          }),
          dirty: true
        }))
      )
      recoveryWin = reg.windows.get(win.webContents.id)
    }
  } catch (err) {
    console.error('[recovery] scan failed:', err)
  }

  // Files queued from Finder / argv join the recovery window when there is one.
  const queued = finderReady((paths) => void openPaths(paths))
  if (queued.length) await openPaths(queued, recoveryWin)

  if (reg.windows.size === 0) createDocWindow()
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
    if (!reg.anyDirty()) {
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
