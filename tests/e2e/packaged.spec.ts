import { test, expect } from '@playwright/test'
import { existsSync } from 'fs'
import { join } from 'path'
import { drawText, launchApp, nonLocal, ROOT, waitForExcalidraw } from './fixtures'

// Smoke test for the packaged app produced by `pnpm build:mac`.
// Skipped unless dist/mac-arm64/Sketchbook.app exists.
const BINARY = join(ROOT, 'dist/mac-arm64/Sketchbook.app/Contents/MacOS/Sketchbook')

test('packaged Sketchbook.app starts offline with bundled fonts', async () => {
  test.skip(!existsSync(BINARY), 'run `pnpm build:mac` first')
  const ctx = await launchApp({ executablePath: BINARY })
  try {
    const { page, app } = ctx
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    await waitForExcalidraw(page)
    expect(page.url()).toBe('app://bundle/index.html')
    await drawText(page, 'Packaged')
    const ok = await page.evaluate(async () => {
      await document.fonts.load('20px Excalifont', 'Packaged')
      return document.fonts.check('20px Excalifont', 'Packaged')
    })
    expect(ok).toBe(true)
    expect(ctx.requests.some((u) => u.startsWith('app://bundle/fonts/Excalifont/'))).toBe(true)
    expect(await ctx.cspViolations()).toEqual([])
    const mainSeen = await app.evaluate(
      () => (globalThis as unknown as { __sbRequests: string[] }).__sbRequests
    )
    expect(nonLocal([...ctx.requests, ...mainSeen])).toEqual([])
  } finally {
    await ctx.close()
  }
})
