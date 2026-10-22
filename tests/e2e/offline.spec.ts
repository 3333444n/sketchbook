import { test, expect, type Page } from '@playwright/test'
import { readFileSync, readdirSync, realpathSync, rmSync } from 'fs'
import { join } from 'path'
import {
  drawText,
  launchApp,
  makeTempDir,
  nonLocal,
  waitForExcalidraw,
  type Launched
} from './fixtures'

const FONTS = ['Excalifont', 'Nunito', 'Comic Shanns', 'Lilita One']

let ctx: Launched

test.beforeEach(async () => {
  ctx = await launchApp()
})

test.afterEach(async () => {
  await ctx?.close()
})

async function pickFont(page: Page, family: string): Promise<void> {
  const quick: Record<string, string> = {
    Excalifont: 'font-family-hand-drawn',
    Nunito: 'font-family-normal',
    'Comic Shanns': 'font-family-code'
  }
  if (quick[family]) {
    await page.getByTestId(quick[family]).click()
    return
  }
  await page.getByTestId('font-family-show-fonts').click()
  await page.locator('.FontPicker__container, .dropdown-menu').getByText(family).first().click()
}

test('renderer is served from app://bundle with the boot script applied', async () => {
  const { page } = ctx
  await waitForExcalidraw(page)
  expect(page.url()).toBe('app://bundle/index.html')
  expect(await page.title()).toBe('Sketchbook')
  const env = await page.evaluate(() => ({
    assetPath: (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH,
    save: 'showSaveFilePicker' in window,
    open: 'showOpenFilePicker' in window,
    dir: 'showDirectoryPicker' in window
  }))
  expect(env).toEqual({ assetPath: 'app://bundle/', save: false, open: false, dir: false })
  // --user-data-dir isolates the profile.
  const userData = await ctx.app.evaluate(({ app }) => app.getPath('userData'))
  expect(realpathSync(userData)).toBe(realpathSync(ctx.userData))
})

test('works fully offline: fonts, mermaid and export use no network and violate no CSP', async () => {
  const { page, app } = ctx
  await waitForExcalidraw(page)

  // One text element per font in the picker.
  for (const [i, family] of FONTS.entries()) {
    await drawText(page, `Hello ${family}`, 300, 160 + i * 90)
    await pickFont(page, family)
    await page.keyboard.press('Escape')
  }

  const fontStatus = await page.evaluate(async (families) => {
    const out: Record<string, { check: boolean; loaded: number }> = {}
    for (const family of families) {
      await document.fonts.load(`20px "${family}"`, 'Hello')
      const faces = [...document.fonts].filter((f) => f.family.replace(/"/g, '') === family)
      out[family] = {
        check: document.fonts.check(`20px "${family}"`, 'Hello'),
        loaded: faces.filter((f) => f.status === 'loaded').length
      }
    }
    return out
  }, FONTS)
  for (const family of FONTS) {
    expect(fontStatus[family].check, `${family} check()`).toBe(true)
    expect(fontStatus[family].loaded, `${family} loaded faces`).toBeGreaterThan(0)
  }
  expect(await page.evaluate(() => document.fonts.check('20px Excalifont'))).toBe(true)

  // Font files must have come from the bundle.
  const fontRequests = ctx.requests.filter((u) => u.endsWith('.woff2'))
  expect(fontRequests.length).toBeGreaterThan(0)
  expect(fontRequests.filter((u) => !u.startsWith('app://bundle/'))).toEqual([])

  // Mermaid dialog (lazy-loads the mermaid chunks and renders a preview).
  await page.locator('.App-toolbar__extra-tools-trigger').click()
  await page.getByText('Mermaid to Excalidraw').first().click()
  const ttd = page.locator('.ttd-dialog')
  await ttd.waitFor({ state: 'visible', timeout: 15_000 })
  await expect(ttd.locator('svg').first()).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  await ttd.waitFor({ state: 'detached' })

  // Export PNG and SVG (SVG export subsets + inlines fonts via wasm).
  // If no will-download handler is installed (Track A not merged), save to a temp dir.
  const downloads = makeTempDir('sketchbook-export-')
  await app.evaluate(({ session, dialog }, dir) => {
    if (session.defaultSession.listenerCount('will-download') > 0) {
      // Track A's handler is present: stub its dialog instead.
      let n = 0
      dialog.showSaveDialogSync = (() =>
        `${dir}/export-${n++}`) as unknown as typeof dialog.showSaveDialogSync
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: `${dir}/export-${n++}`
      })) as unknown as typeof dialog.showSaveDialog
      return
    }
    session.defaultSession.on('will-download', (_e, item) => {
      item.setSavePath(`${dir}/${Date.now()}-${item.getFilename()}`)
    })
  }, downloads)

  // Excalidraw's own UI: main menu -> "Export image..."
  await page.getByTestId('main-menu-trigger').click()
  await page.getByTestId('image-export-button').click()
  const modal = page.locator('.ImageExportModal')
  await modal.waitFor({ state: 'visible' })
  await modal.getByLabel('Export to PNG').click()
  await expect.poll(() => readdirSync(downloads).length, { timeout: 15_000 }).toBe(1)
  await modal.getByLabel('Export to SVG').click()
  await expect.poll(() => readdirSync(downloads).length, { timeout: 15_000 }).toBe(2)
  await page.keyboard.press('Escape')
  const files = readdirSync(downloads).map((f) => readFileSync(join(downloads, f)))
  expect(files.some((b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))).toBe(
    true
  )
  const svg = files.map((b) => b.toString('utf8')).find((s) => s.includes('<svg'))
  expect(svg, 'exported svg').toBeTruthy()
  expect(svg).toContain('@font-face')
  rmSync(downloads, { recursive: true, force: true })

  await page.waitForTimeout(500)
  expect(await ctx.cspViolations(), 'CSP violations').toEqual([])

  const mainSeen = await app.evaluate(
    () => (globalThis as unknown as { __sbRequests: string[] }).__sbRequests
  )
  expect(nonLocal([...ctx.requests, ...mainSeen]), 'non-local requests').toEqual([])
})

test('network requests are blocked by the main process', async () => {
  // Bypass the renderer CSP: go straight through the default session, which is
  // where the onBeforeRequest guard lives.
  const result = await ctx.app.evaluate(async ({ session }) => {
    try {
      await session.defaultSession.fetch('https://example.com/should-not-load')
      return 'loaded'
    } catch (e) {
      return `blocked: ${String(e)}`
    }
  })
  expect(result).toMatch(/^blocked/)
})

test('app:// refuses path traversal', async () => {
  const { page } = ctx
  await waitForExcalidraw(page)
  const statuses = await page.evaluate(async () => {
    const urls = [
      'app://bundle/index.html',
      'app://bundle/../main/index.js',
      'app://bundle/%2e%2e/main/index.js',
      'app://bundle/..%2fmain%2findex.js',
      'app://bundle/fonts/../../main/index.js',
      'app://other/index.html'
    ]
    const out: number[] = []
    for (const u of urls) {
      try {
        out.push((await fetch(u)).status)
      } catch {
        out.push(-1)
      }
    }
    return out
  })
  expect(statuses[0]).toBe(200)
  for (const s of statuses.slice(1)) expect([404, -1]).toContain(s)
})
