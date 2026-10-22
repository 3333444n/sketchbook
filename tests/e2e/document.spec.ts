import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { IPC } from '../../src/shared/ipc'
import { join } from 'path'
import { drawText, launchApp, makeTempDir, waitForExcalidraw } from './fixtures'

// Contract v2 (tabs): `window.sketchbook.save(docId, contents, { saveAs })` resolves
// the target via `dialog.showSaveDialog` for untitled docs and writes the file; the
// renderer routes the 'save' MenuAction (IPC.menu) to the active tab; paths in argv
// open as tabs.

/** Titles shown in the renderer's tab strip, in order. */
function tabTitles(page: Page): Promise<string[]> {
  return page.$$eval('.sketchbook-tab__title', (els) => els.map((e) => e.textContent ?? ''))
}

function sceneJSON(text: string): string {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'sketchbook-e2e',
    elements: [
      {
        id: `t-${text}`,
        type: 'text',
        x: 100,
        y: 100,
        width: 100,
        height: 25,
        text,
        originalText: text,
        fontSize: 20,
        fontFamily: 5,
        version: 1,
        versionNonce: 1,
        seed: 1
      }
    ],
    appState: {},
    files: {}
  })
}

async function stubSaveDialog(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: f
    })) as typeof dialog.showSaveDialog
    dialog.showSaveDialogSync = (() => f) as typeof dialog.showSaveDialogSync
  }, file)
}

test('save then reopen from argv round-trips the drawing', async () => {
  const dir = makeTempDir('sketchbook-doc-')
  const file = join(dir, 'roundtrip.excalidraw')
  try {
    const first = await launchApp()
    try {
      await stubSaveDialog(first.app, file)

      await waitForExcalidraw(first.page)
      await drawText(first.page, 'Round trip')

      // Ask the renderer to save, exactly as the native File > Save menu does.
      await first.app.evaluate(({ BrowserWindow }, channel) => {
        BrowserWindow.getAllWindows()[0].webContents.send(channel, 'save')
      }, IPC.menu)
      await expect.poll(() => existsSync(file), { timeout: 10_000 }).toBe(true)
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      expect(saved.type).toBe('excalidraw')
      const texts = saved.elements.filter((e: { type: string }) => e.type === 'text')
      expect(texts.map((e: { text: string }) => e.text)).toContain('Round trip')
    } finally {
      await first.close()
    }

    const second = await launchApp({ args: [file], reload: false })
    try {
      await waitForExcalidraw(second.page)
      await expect.poll(() => tabTitles(second.page), { timeout: 10_000 }).toEqual(['roundtrip'])
      // Selecting everything shows the properties panel only if the scene has elements.
      await second.page
        .locator('.sketchbook-editor--active canvas.interactive')
        .click({ position: { x: 5, y: 5 } })
      await second.page.keyboard.press('Meta+A')
      await expect(
        second.page.locator('.App-menu__left, .properties-content').first()
      ).toBeVisible()
    } finally {
      await second.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('files from argv open as tabs; closing one leaves the other', async () => {
  const dir = makeTempDir('sketchbook-tabs-')
  const a = join(dir, 'alpha.excalidraw')
  const b = join(dir, 'beta.excalidraw')
  writeFileSync(a, sceneJSON('Alpha'))
  writeFileSync(b, sceneJSON('Beta'))
  const launched = await launchApp({ args: [a, b], reload: false })
  const { page } = launched
  try {
    await waitForExcalidraw(page)
    await expect.poll(() => tabTitles(page), { timeout: 10_000 }).toEqual(['alpha', 'beta'])
    await expect(page.locator('.sketchbook-tab--active')).toHaveText(/beta/)

    // Switch tabs from the strip.
    await page.locator('.sketchbook-tab', { hasText: 'alpha' }).click()
    await expect(page.locator('.sketchbook-tab--active')).toHaveText(/alpha/)

    // Close the (clean) active tab with its ✕: no prompt, the other tab remains.
    await page
      .locator('.sketchbook-tab', { hasText: 'alpha' })
      .locator('.sketchbook-tab__close')
      .click()
    await expect.poll(() => tabTitles(page), { timeout: 10_000 }).toEqual(['beta'])
    await expect(page.locator('.sketchbook-tab--active')).toHaveText(/beta/)
    await expect(page.locator('.sketchbook-editor')).toHaveCount(1)
  } finally {
    await launched.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
