import { describe, expect, it } from 'vitest'
import { Registry } from '../registry'
import type { DocPayload } from '../../shared/ipc'

const p = (
  docId: string,
  path: string | null = null,
  contents: string | null = null
): DocPayload => ({
  docId,
  path,
  contents
})

function setup(): Registry<string> {
  const r = new Registry<string>()
  r.addWindow(1, 'win1')
  r.addWindow(2, 'win2')
  r.addDoc(1, p('a'))
  r.addDoc(1, p('b', '/x/B.excalidraw', '{}'))
  r.addDoc(2, p('c', '/x/C.excalidraw', '{}'))
  return r
}

describe('Registry', () => {
  it('tracks docs per window in insertion order; newest is active', () => {
    const r = setup()
    expect(r.docsOf(1).map((d) => d.docId)).toEqual(['a', 'b'])
    expect(r.windows.get(1)!.activeDocId).toBe('b')
    expect(r.initialState(1)).toEqual({
      docs: [p('a'), p('b', '/x/B.excalidraw', '{}')],
      activeDocId: 'b'
    })
    expect(r.initialState(99)).toBeUndefined()
  })

  it('rejects duplicate doc ids and unknown windows', () => {
    const r = setup()
    expect(() => r.addDoc(1, p('c'))).toThrow()
    expect(() => r.addDoc(7, p('z'))).toThrow()
  })

  it('only resolves a doc for the window that owns it', () => {
    const r = setup()
    expect(r.docOf(1, 'a')?.docId).toBe('a')
    expect(r.docOf(2, 'a')).toBeUndefined()
    expect(r.docOf(1, 'nope')).toBeUndefined()
    expect(r.docOf(1, 42)).toBeUndefined()
  })

  it('setActive ignores docs from other windows', () => {
    const r = setup()
    expect(r.setActive(1, 'a')).toBe(true)
    expect(r.setActive(1, 'c')).toBe(false)
    expect(r.windows.get(1)!.activeDocId).toBe('a')
  })

  it('finds docs by path across windows', () => {
    const r = setup()
    expect(r.findByPath('/x/C.excalidraw')?.winId).toBe(2)
    expect(r.findByPath('/x/none.excalidraw')).toBeUndefined()
  })

  it('reuses only a pristine untitled active doc', () => {
    const r = setup()
    expect(r.reusableDoc(1)).toBeNull() // active is 'b' (has a path)
    r.setActive(1, 'a')
    expect(r.reusableDoc(1)?.docId).toBe('a')
    r.docs.get('a')!.dirty = true
    expect(r.reusableDoc(1)).toBeNull()
    r.docs.get('a')!.dirty = false
    r.docs.get('a')!.empty = false
    expect(r.reusableDoc(1)).toBeNull()
    r.docs.get('a')!.empty = true
    r.docs.get('a')!.pendingClose = true
    expect(r.reusableDoc(1)).toBeNull()
  })

  it('derives window chrome from the active doc and any-dirty', () => {
    const r = setup()
    expect(r.chrome(1)).toEqual({
      title: 'B',
      representedFilename: '/x/B.excalidraw',
      documentEdited: false
    })
    r.docs.get('a')!.dirty = true
    expect(r.chrome(1)).toEqual({
      title: 'B',
      representedFilename: '/x/B.excalidraw',
      documentEdited: true
    })
    r.setActive(1, 'a')
    expect(r.chrome(1)).toEqual({
      title: 'Untitled — Edited',
      representedFilename: '',
      documentEdited: true
    })
    expect(r.anyDirty()).toBe(true)
    expect(r.anyDirty(2)).toBe(false)
  })

  it('removeDoc moves the active doc to a remaining tab', () => {
    const r = setup()
    const w = r.removeDoc('b')
    expect(w?.id).toBe(1)
    expect(w?.activeDocId).toBe('a')
    expect(r.docs.has('b')).toBe(false)
    r.removeDoc('a')
    expect(r.windows.get(1)!.docIds.size).toBe(0)
    expect(r.windows.get(1)!.activeDocId).toBeNull()
    expect(r.removeDoc('a')).toBeUndefined()
  })

  it('removeWindow drops its docs and returns them', () => {
    const r = setup()
    expect(r.removeWindow(1).map((d) => d.docId)).toEqual(['a', 'b'])
    expect(r.windows.has(1)).toBe(false)
    expect([...r.docs.keys()]).toEqual(['c'])
    expect(r.removeWindow(1)).toEqual([])
  })
})
