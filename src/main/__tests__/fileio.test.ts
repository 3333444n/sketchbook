import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  atomicWrite,
  displayName,
  ensureExtension,
  isNativeScene,
  readDocContents,
  windowTitle
} from '../fileio'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sketchbook-fileio-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('atomicWrite', () => {
  it('writes a new file and leaves no temp file', async () => {
    const p = join(dir, 'a.excalidraw')
    await atomicWrite(p, '{"a":1}')
    expect(readFileSync(p, 'utf8')).toBe('{"a":1}')
    expect(readdirSync(dir)).toEqual(['a.excalidraw'])
  })

  it('replaces an existing file', async () => {
    const p = join(dir, 'a.excalidraw')
    writeFileSync(p, 'old contents that are longer')
    await atomicWrite(p, 'new')
    expect(readFileSync(p, 'utf8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['a.excalidraw'])
  })

  it('rejects and cleans up when the directory does not exist', async () => {
    await expect(atomicWrite(join(dir, 'missing', 'a.excalidraw'), 'x')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('ensureExtension', () => {
  it('appends when missing', () => {
    expect(ensureExtension('/x/Drawing', '.excalidraw')).toBe('/x/Drawing.excalidraw')
    expect(ensureExtension('/x/Drawing.png', '.excalidraw')).toBe('/x/Drawing.png.excalidraw')
  })
  it('keeps an existing extension, case-insensitively', () => {
    expect(ensureExtension('/x/D.excalidraw', '.excalidraw')).toBe('/x/D.excalidraw')
    expect(ensureExtension('/x/D.EXCALIDRAW', 'excalidraw')).toBe('/x/D.EXCALIDRAW')
  })
})

describe('names', () => {
  it('derives display names and titles', () => {
    expect(displayName(null)).toBe('Untitled')
    expect(displayName('/a/My Plan.excalidraw')).toBe('My Plan')
    expect(windowTitle(null, true)).toBe('Untitled — Edited')
    expect(windowTitle('/a/b.excalidraw', false)).toBe('b')
    expect(isNativeScene('/a/b.excalidraw')).toBe(true)
    expect(isNativeScene('/a/b.png')).toBe(false)
  })
})

describe('readDocContents', () => {
  it('returns PNG as a data URL and text as utf8', async () => {
    const png = join(dir, 'x.png')
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(await readDocContents(png)).toBe('data:image/png;base64,iVBORw==')
    const svg = join(dir, 'x.svg')
    writeFileSync(svg, '<svg/>')
    expect(await readDocContents(svg)).toBe('<svg/>')
  })
})
