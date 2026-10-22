// Track C: app:// scheme, renderer loading and the offline network guard.
//
// In production the renderer is served from `app://bundle/...` (a standard,
// secure origin) rather than file://, so relative URLs, fetch(), workers and
// font loading behave like a normal website — with no network involved.
import { BrowserWindow, net, protocol, session } from 'electron'
import { extname, join, relative, resolve, sep, isAbsolute } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'

export const APP_SCHEME = 'app'
export const APP_HOST = 'bundle'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
}

/** Directory holding the built renderer (out/renderer, inside app.asar when packaged). */
function rendererRoot(): string {
  return resolve(join(__dirname, '../renderer'))
}

/** The dev-server origin (e.g. http://localhost:5173), only in development. */
function devServerOrigin(): string | null {
  const url = process.env['ELECTRON_RENDERER_URL']
  if (!is.dev || !url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * True when `url` belongs to Sketchbook's own UI: `app://bundle/...`, or in
 * development the electron-vite dev server. Use it for `will-navigate`,
 * `setWindowOpenHandler` and similar checks.
 */
export function isAppUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST) return true
  const dev = devServerOrigin()
  return dev !== null && parsed.origin === dev
}

/** Register privileged schemes. Called before `app.ready`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        codeCache: true
      }
    }
  ])
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' }
  })
}

/**
 * Map an app:// request URL to a file inside the renderer directory.
 * Returns null for anything that would escape it (path traversal) or a wrong host.
 */
export function resolveAppPath(requestUrl: string, root = rendererRoot()): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.host !== APP_HOST) return null
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0')) return null
  if (pathname === '/' || pathname === '') pathname = '/index.html'
  const filePath = resolve(root, '.' + pathname)
  return isInside(filePath, root) ? filePath : null
}

/** True when `filePath` is strictly inside `root`. */
function isInside(filePath: string, root: string): boolean {
  const rel = relative(root, resolve(filePath))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..')
}

/** Only these URL schemes may ever be requested by the app in production. */
const ALLOWED_SCHEMES = new Set(['app:', 'data:', 'blob:', 'devtools:', 'chrome-extension:'])

function isAllowedRequest(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (ALLOWED_SCHEMES.has(parsed.protocol)) return true
  // The app:// handler itself reads bundled files via net.fetch(file://...).
  if (parsed.protocol === 'file:') {
    try {
      return isInside(fileURLToPath(parsed), rendererRoot())
    } catch {
      return false
    }
  }
  const dev = devServerOrigin()
  if (dev) {
    // Vite dev server + its HMR websocket.
    const devUrl = new URL(dev)
    const sameHost = parsed.hostname === devUrl.hostname && parsed.port === devUrl.port
    if (sameHost && ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return true
  }
  return false
}

let protocolInstalled = false

/**
 * Install protocol handlers and the network guard. Called after `app.ready`.
 * Idempotent: `loadRenderer()` also calls it, because a window may be created
 * (by another `whenReady` callback) before the bootstrap gets here, and a
 * navigation to app:// issued before `protocol.handle` never completes.
 */
export function registerAppProtocol(): void {
  if (protocolInstalled) return
  protocolInstalled = true
  const root = rendererRoot()

  protocol.handle(APP_SCHEME, async (request) => {
    const filePath = resolveAppPath(request.url, root)
    if (!filePath) return notFound()
    let res: Response
    try {
      res = await net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return notFound()
    }
    if (!res.ok) return notFound()
    const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    const headers = new Headers(res.headers)
    headers.set('content-type', type)
    headers.set('x-content-type-options', 'nosniff')
    return new Response(res.body, { status: 200, headers })
  })

  // Defence in depth: Sketchbook never talks to the network. Cancel anything
  // that isn't local so behaviour online is identical to behaviour offline.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (isAllowedRequest(details.url)) {
      callback({})
      return
    }
    console.warn(`[sketchbook] blocked network request: ${details.method} ${details.url}`)
    callback({ cancel: true })
  })
}

/** Load the renderer UI into a window (dev server in dev, bundled files in prod). */
export function loadRenderer(win: BrowserWindow): Promise<void> {
  // Guarantees the app:// handler and network guard exist before any page loads.
  registerAppProtocol()
  const dev = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  if (dev) return win.loadURL(dev)
  return win.loadURL(`${APP_ORIGIN}/index.html`)
}
