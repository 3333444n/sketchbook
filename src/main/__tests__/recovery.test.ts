import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { deleteJournal, scanJournals, writeJournal } from '../recovery'

let root: string
let dir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sketchbook-recovery-'))
  dir = join(root, 'recovery') // does not exist yet
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('recovery journal', () => {
  it('returns [] when the directory is missing', async () => {
    expect(await scanJournals(dir)).toEqual([])
  })

  it('writes, scans and deletes journals', async () => {
    await writeJournal(dir, { docId: 'doc-a', path: null, contents: '{"x":1}' }, 100)
    await writeJournal(dir, { docId: 'doc-b', path: '/tmp/b.excalidraw', contents: 'B' }, 50)
    // Overwrite keeps a single file per doc.
    await writeJournal(dir, { docId: 'doc-a', path: null, contents: '{"x":2}' }, 200)

    const found = await scanJournals(dir)
    expect(found).toEqual([
      { docId: 'doc-b', path: '/tmp/b.excalidraw', contents: 'B', savedAt: 50 },
      { docId: 'doc-a', path: null, contents: '{"x":2}', savedAt: 200 }
    ])
    expect(readdirSync(dir).sort()).toEqual(['doc-a.json', 'doc-b.json'])

    await deleteJournal(dir, 'doc-a')
    await deleteJournal(dir, 'does-not-exist')
    expect((await scanJournals(dir)).map((j) => j.docId)).toEqual(['doc-b'])
  })

  it('moves corrupt and invalid journals aside without throwing', async () => {
    mkdirSync(dir, { recursive: true })
    await writeJournal(dir, { docId: 'good', path: null, contents: 'ok' })
    writeFileSync(join(dir, 'broken.json'), '{not json')
    writeFileSync(join(dir, 'wrongshape.json'), JSON.stringify({ docId: 'other', contents: 1 }))
    writeFileSync(join(dir, 'notes.txt'), 'ignored')

    const found = await scanJournals(dir)
    expect(found.map((j) => j.docId)).toEqual(['good'])
    expect(existsSync(join(dir, 'broken.json'))).toBe(false)
    expect(existsSync(join(dir, 'wrongshape.json'))).toBe(false)
    expect(readdirSync(join(dir, 'corrupt'))).toHaveLength(2)
    // Second scan is stable.
    expect((await scanJournals(dir)).map((j) => j.docId)).toEqual(['good'])
  })

  it('rejects unsafe doc ids', async () => {
    await expect(
      writeJournal(dir, { docId: '../evil', path: null, contents: 'x' })
    ).rejects.toThrow()
  })
})
