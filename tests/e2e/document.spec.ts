import { test, expect, type ElectronApplication } from '@playwright/test'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { drawText, launchApp, makeTempDir, waitForExcalidraw } from './fixtures'

// Contract (Track A/B): `window.sketchbook.save(contents, { saveAs })` resolves the
// target via `dialog.showSaveDialog` for untitled docs and writes the file; the
// renderer handles the 'save' MenuAction; a path in argv opens that document.

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

      // Probe the main-process save handler: the scaffold stub returns null.
      const probe = await first.page.evaluate(
        (c) =>
          (
            window as unknown as {
              sketchbook: { save: (c: string, o: { saveAs: boolean }) => Promise<unknown> }
            }
          ).sketchbook.save(c, { saveAs: true }),
        JSON.stringify({
          type: 'excalidraw',
          version: 2,
          source: 'sketchbook-e2e',
          elements: [],
          appState: {},
          files: {}
        })
      )
      test.fixme(probe === null, 'document save (Track A) is not in this build yet')
      rmSync(file, { force: true })

      await waitForExcalidraw(first.page)
      await drawText(first.page, 'Round trip')

      // Ask the renderer to save, exactly as the native File > Save menu does.
      await first.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.send('menu:action', 'save')
      })
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
      await expect.poll(() => second.page.title(), { timeout: 10_000 }).toContain('roundtrip')
      // Selecting everything shows the properties panel only if the scene has elements.
      await second.page.locator('canvas.interactive').click({ position: { x: 5, y: 5 } })
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
