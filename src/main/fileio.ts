// Pure file helpers (no 'electron' import) so they can be unit tested in node.
import { promises as fs } from 'fs'
import { basename, dirname, extname, join } from 'path'
import { randomBytes } from 'crypto'

/** File types the Open dialog accepts. */
export const OPENABLE_EXTENSIONS = ['excalidraw', 'json', 'png', 'svg'] as const

/** Native format for Save. */
export const SCENE_EXTENSION = '.excalidraw'

/**
 * Write `data` to `filePath` atomically: write a temp file in the same
 * directory, fsync it, then rename over the target. Readers never observe a
 * half-written file and a crash mid-write leaves the original intact.
 */
export async function atomicWrite(filePath: string, data: string | Uint8Array): Promise<void> {
  const tmp = join(
    dirname(filePath),
    `.${basename(filePath)}.tmp-${randomBytes(6).toString('hex')}`
  )
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(tmp, 'w', 0o644)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(tmp, filePath)
  } catch (err) {
    if (handle) await handle.close().catch(() => {})
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/** Append `ext` (e.g. ".excalidraw") unless the path already ends with it (case-insensitive). */
export function ensureExtension(filePath: string, ext: string): string {
  const e = ext.startsWith('.') ? ext : `.${ext}`
  return filePath.toLowerCase().endsWith(e.toLowerCase()) ? filePath : filePath + e
}

/** Lower-case extension without the dot ("" if none). */
export function extOf(filePath: string): string {
  return extname(filePath).slice(1).toLowerCase()
}

/** True for files Save can write back to directly (only native .excalidraw). */
export function isNativeScene(filePath: string): boolean {
  return extOf(filePath) === SCENE_EXTENSION.slice(1)
}

export function isOpenable(filePath: string): boolean {
  return (OPENABLE_EXTENSIONS as readonly string[]).includes(extOf(filePath))
}

/** Display name: basename without extension, or "Untitled". */
export function displayName(filePath: string | null): string {
  if (!filePath) return 'Untitled'
  const b = basename(filePath)
  const e = extname(b)
  return e ? b.slice(0, -e.length) : b
}

export function windowTitle(filePath: string | null, dirty: boolean): string {
  return displayName(filePath) + (dirty ? ' — Edited' : '')
}

/**
 * Read a document for a DocPayload.
 *
 * NOTE for the renderer: DocPayload.contents is always a string.
 *  - .png files are read as binary and returned as a
 *    `data:image/png;base64,...` URL. Detect the `data:` prefix and convert it
 *    to a Blob (e.g. `await (await fetch(contents)).blob()`) before passing it
 *    to Excalidraw's `loadFromBlob`.
 *  - .excalidraw / .json / .svg are returned as UTF-8 text.
 */
export async function readDocContents(filePath: string): Promise<string> {
  if (extOf(filePath) === 'png') {
    const buf = await fs.readFile(filePath)
    return `data:image/png;base64,${buf.toString('base64')}`
  }
  return fs.readFile(filePath, 'utf8')
}
