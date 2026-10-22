import { test, expect } from '@playwright/test'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { drawText, launchApp, makeTempDir, waitForExcalidraw, type Launched } from './fixtures'

// Contract (Track A, src/main/documents.ts): the session's `will-download`
// handler asks for a destination with `dialog.showSaveDialogSync` and saves there.
// browser-fs-access falls back to <a download> because boot.js hides the
// File System Access API, so Excalidraw's export buttons end up as downloads.

let ctx: Launched
let outDir: string

test.beforeEach(async () => {
  ctx = await launchApp()
  outDir = makeTempDir('sketchbook-export-')
})

test.afterEach(async () => {
  await ctx?.close()
  rmSync(outDir, { recursive: true, force: true })
})

test('exporting PNG goes through the native save dialog', async () => {
  const { app, page } = ctx
  const target = join(outDir, 'drawing.png')

  const hasHandler = await app.evaluate(
    ({ session }) => session.defaultSession.listenerCount('will-download') > 0
  )
  test.fixme(!hasHandler, 'will-download handler (Track A) is not in this build yet')

  await app.evaluate(({ dialog }, file) => {
    const g = globalThis as unknown as { __sbDialogCalls: number }
    g.__sbDialogCalls = 0
    dialog.showSaveDialogSync = (() => {
      g.__sbDialogCalls++
      return file
    }) as typeof dialog.showSaveDialogSync
    dialog.showSaveDialog = (async () => {
      g.__sbDialogCalls++
      return { canceled: false, filePath: file }
    }) as typeof dialog.showSaveDialog
  }, target)

  await waitForExcalidraw(page)
  await drawText(page, 'Export me')

  await page.getByTestId('main-menu-trigger').click()
  await page.getByTestId('image-export-button').click()
  const modal = page.locator('.ImageExportModal')
  await modal.waitFor({ state: 'visible' })
  await modal.getByLabel('Export to PNG').click()

  await expect.poll(() => existsSync(target), { timeout: 15_000 }).toBe(true)
  await expect
    .poll(() => readFileSync(target).subarray(0, 8).toString('hex'), { timeout: 5_000 })
    .toBe('89504e470d0a1a0a')
  const calls = await app.evaluate(
    () => (globalThis as unknown as { __sbDialogCalls: number }).__sbDialogCalls
  )
  expect(calls).toBeGreaterThan(0)
})
