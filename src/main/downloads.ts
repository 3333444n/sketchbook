// Routes renderer `<a download>` downloads (Excalidraw "Save as image", library
// export) through a native Save dialog.
import { app, BrowserWindow, dialog, session } from 'electron'
import { extname, join } from 'path'

let installed = false

export function installDownloadHandler(): void {
  if (installed) return
  installed = true
  session.defaultSession.on('will-download', (_e, item, wc) => {
    const filename = item.getFilename() || 'download'
    const ext = extname(filename).slice(1).toLowerCase()
    const filters = ext
      ? [{ name: `${ext.toUpperCase()} file`, extensions: [ext] }]
      : [{ name: 'All Files', extensions: ['*'] }]
    const win = wc ? BrowserWindow.fromWebContents(wc) : null
    const opts = { defaultPath: join(app.getPath('downloads'), filename), filters }
    // Sync on purpose: setSavePath must be called before this handler returns,
    // and e2e tests stub dialog.showSaveDialogSync via app.evaluate.
    const target = win ? dialog.showSaveDialogSync(win, opts) : dialog.showSaveDialogSync(opts)
    if (!target) {
      item.cancel()
      return
    }
    item.setSavePath(target)
  })
}
