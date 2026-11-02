import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import type { AgentPointer } from '../../src/shared/agent'

export const ROOT = resolve(__dirname, '../..')
export const MAIN = join(ROOT, 'out/main/index.js')

export type Launched = {
  app: ElectronApplication
  page: Page
  userData: string
  /** Every URL requested by the renderer or seen by the main session. */
  requests: string[]
  /** CSP violations reported in the page. */
  cspViolations: () => Promise<string[]>
  close: () => Promise<void>
}

export function makeTempDir(prefix = 'sketchbook-e2e-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * Launch the production build with an isolated profile.
 * `--user-data-dir` is a Chromium switch that Electron honours for app.getPath('userData').
 */
export async function launchApp(
  opts: { args?: string[]; userData?: string; executablePath?: string; reload?: boolean } = {}
): Promise<Launched> {
  const userData = opts.userData ?? makeTempDir()
  const ownsUserData = !opts.userData
  const args = opts.executablePath
    ? [`--user-data-dir=${userData}`, ...(opts.args ?? [])]
    : [MAIN, `--user-data-dir=${userData}`, ...(opts.args ?? [])]

  const app = await electron.launch({
    args,
    executablePath: opts.executablePath,
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_RENDERER_URL: '' }
  })

  const requests: string[] = []
  // Main-process view of the network (everything Chromium tried, including blocked ones).
  await app.evaluate(({ session }) => {
    const g = globalThis as unknown as { __sbRequests: string[] }
    g.__sbRequests = []
    const record = (d: { url: string }): void => {
      g.__sbRequests.push(d.url)
    }
    session.defaultSession.webRequest.onCompleted(record)
    session.defaultSession.webRequest.onErrorOccurred(record)
  })

  const page = await app.firstWindow()
  const consoleCsp: string[] = []
  page.on('request', (r) => requests.push(r.url()))
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) consoleCsp.push(m.text())
    if (process.env['SB_E2E_DEBUG']) console.log(`[renderer:${m.type()}] ${m.text()}`)
  })
  page.on('pageerror', (e) => {
    if (process.env['SB_E2E_DEBUG']) console.log(`[renderer:pageerror] ${e.stack ?? e}`)
  })
  await page.waitForLoadState('domcontentloaded')
  await installCspListener(page)
  if (opts.reload !== false) {
    // The window may have loaded before our listeners attached: reload once so
    // request/CSP recording covers the whole page lifecycle.
    await page.reload()
  }

  return {
    app,
    page,
    userData,
    requests,
    cspViolations: async () => [
      ...consoleCsp,
      ...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []))
    ],
    close: async () => {
      const mainSeen = await app
        .evaluate(() => (globalThis as unknown as { __sbRequests: string[] }).__sbRequests)
        .catch(() => [] as string[])
      requests.push(...mainSeen)
      // Tests leave drawings dirty: answer main's "save changes?" prompts with
      // "Don't Save" so quitting doesn't block on a native dialog.
      await app
        .evaluate(({ dialog }) => {
          const dontSave = { response: 1, checkboxChecked: false }
          dialog.showMessageBox = (async () => dontSave) as unknown as typeof dialog.showMessageBox
          dialog.showMessageBoxSync = (() => 1) as unknown as typeof dialog.showMessageBoxSync
        })
        .catch(() => undefined)
      await app.close().catch(() => undefined)
      if (ownsUserData) rmSync(userData, { recursive: true, force: true })
    }
  }
}

async function installCspListener(page: Page): Promise<void> {
  // addInitScript only affects future navigations; also install now.
  const script = (): void => {
    const w = window as unknown as { __csp?: string[] }
    if (w.__csp) return
    w.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp!.push(`${e.violatedDirective} ${e.blockedURI}`)
    })
  }
  await page.addInitScript(script)
  await page.evaluate(script)
}

/** Wait until Excalidraw's canvas UI is interactive. */
export async function waitForExcalidraw(page: Page): Promise<void> {
  await page.locator('.excalidraw').waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator('canvas.interactive').waitFor({ state: 'visible' })
}

/** Draw a text element at (x, y) using the keyboard shortcut for the text tool. */
export async function drawText(page: Page, text: string, x = 400, y = 300): Promise<void> {
  await page.locator('canvas.interactive').click({ position: { x: 10, y: 10 } })
  await page.keyboard.press('t')
  await page.mouse.click(x, y)
  const editor = page.locator('textarea.excalidraw-wysiwyg')
  await editor.waitFor({ state: 'visible' })
  await page.keyboard.type(text)
  await page.keyboard.press('Escape')
  await editor.waitFor({ state: 'detached' })
}

export const LOCAL_SCHEMES = ['app:', 'data:', 'blob:', 'devtools:', 'chrome-extension:']

export function nonLocal(urls: string[]): string[] {
  return urls.filter((u) => {
    try {
      const p = new URL(u)
      if (LOCAL_SCHEMES.includes(p.protocol)) return false
      // The app:// handler reads bundled files from inside out/renderer (or app.asar).
      if (p.protocol === 'file:' && decodeURIComponent(p.pathname).includes('/renderer/'))
        return false
      return true
    } catch {
      return true
    }
  })
}

// ---- agent bridge ----------------------------------------------------------

/** `userData/settings.json` as main persists it. */
export function settingsPath(userData: string): string {
  return join(userData, 'settings.json')
}

/** `userData/agent/agent.json`, present only while the bridge is listening. */
export function pointerPath(userData: string): string {
  return join(userData, 'agent', 'agent.json')
}

export function readSettings(userData: string): Record<string, unknown> | null {
  const file = settingsPath(userData)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

/** Pre-write the profile so the bridge starts with the app (no menu round trip). */
export function makeAgentProfile(): string {
  const userData = makeTempDir('sketchbook-agent-')
  mkdirSync(userData, { recursive: true })
  writeFileSync(settingsPath(userData), JSON.stringify({ allowAgentConnections: true }) + '\n')
  return userData
}

export function readPointer(userData: string): AgentPointer | null {
  const file = pointerPath(userData)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AgentPointer
  } catch {
    return null
  }
}

/** Poll until main has written the pointer file (bridge up). */
export async function waitForPointer(userData: string, timeoutMs = 15_000): Promise<AgentPointer> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const p = readPointer(userData)
    if (p && existsSync(p.socketPath)) return p
    if (Date.now() > deadline) throw new Error(`agent pointer did not appear in ${userData}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Poll until the pointer file is gone (bridge down). */
export async function waitForNoPointer(userData: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (existsSync(pointerPath(userData))) {
    if (Date.now() > deadline) throw new Error(`agent pointer still present in ${userData}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Click the "Allow Agent Connections" checkbox exactly as the user would. */
export async function toggleAgentMenu(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('allow-agent-connections')
    if (!item) throw new Error('menu item allow-agent-connections not found')
    item.click()
    return item.checked
  })
}
