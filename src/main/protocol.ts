// Track C owns this file. Stub: real app:// scheme comes later.
import { BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/** Register privileged schemes. Called before `app.ready`. */
export function registerAppScheme(): void {}

/** Install protocol handlers. Called after `app.ready`. */
export function registerAppProtocol(): void {}

/** Load the renderer UI into a window (dev server in dev, bundled files in prod). */
export function loadRenderer(win: BrowserWindow): Promise<void> {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  }
  return win.loadFile(join(__dirname, '../renderer/index.html'))
}
