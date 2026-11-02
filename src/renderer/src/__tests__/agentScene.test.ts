import { describe, expect, it } from 'vitest'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import {
  applyPatch,
  arrowBinding,
  commonBounds,
  isAgentError,
  planDelete,
  prepareSkeletons,
  routeArrow,
  ROUTE_GAP,
  summarizeElements,
  validateIds,
  validateSkeletons
} from '../agentScene'

// Minimal element fixtures: only the fields the helpers read, cast to the real types.
type Partial_ = Partial<ExcalidrawElement> & { id: string; type: string }
const el = (p: Partial_): ExcalidrawElement =>
  ({
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    strokeWidth: 2,
    strokeStyle: 'solid',
    fillStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    boundElements: null,
    link: null,
    locked: false,
    isDeleted: false,
    ...p
  }) as unknown as ExcalidrawElement

const rect = el({
  id: 'r1',
  type: 'rectangle',
  x: 10,
  y: 20,
  width: 200,
  height: 100,
  boundElements: [
    { id: 't1', type: 'text' },
    { id: 'a1', type: 'arrow' }
  ]
})
const label = el({
  id: 't1',
  type: 'text',
  x: 50,
  y: 60,
  width: 40,
  height: 20,
  text: 'Hello\nwrapped',
  originalText: 'Hello wrapped',
  containerId: 'r1',
  fontSize: 20,
  fontFamily: 1,
  textAlign: 'center'
} as Partial_)
const ellipse = el({
  id: 'e1',
  type: 'ellipse',
  x: 400,
  y: 20,
  boundElements: [{ id: 'a1', type: 'arrow' }]
})
const arrow = el({
  id: 'a1',
  type: 'arrow',
  x: 210,
  y: 70,
  width: 190,
  height: 0,
  points: [
    [0, 0],
    [190, 0]
  ],
  startBinding: { elementId: 'r1', focus: 0, gap: 1 },
  endBinding: { elementId: 'e1', focus: 0, gap: 1 }
} as Partial_)
const framed = el({
  id: 'f1',
  type: 'frame',
  x: 0,
  y: 0,
  width: 600,
  height: 300,
  name: 'Flow'
} as Partial_)
const member = el({ id: 'm1', type: 'diamond', x: 20, y: 200, frameId: 'f1' })
const deleted = el({ id: 'gone', type: 'rectangle', isDeleted: true })
const scene = [rect, label, ellipse, arrow, framed, member, deleted]

describe('summarizeElements', () => {
  const byId = new Map(summarizeElements(scene).map((s) => [s.id, s]))

  it('resolves labels from bound text and bindings from arrows', () => {
    expect(byId.get('r1')?.label).toBe('Hello wrapped')
    expect(byId.get('t1')?.text).toBe('Hello wrapped')
    expect(byId.get('t1')?.containerId).toBe('r1')
    expect(byId.get('a1')).toMatchObject({
      start: 'r1',
      end: 'e1',
      points: [
        [0, 0],
        [190, 0]
      ]
    })
    expect(byId.get('m1')?.frameId).toBe('f1')
    expect(byId.get('f1')?.name).toBe('Flow')
  })

  it('omits undefined keys and skips deleted elements', () => {
    expect(byId.has('gone')).toBe(false)
    const r = byId.get('r1')!
    expect(Object.keys(r)).not.toContain('text')
    expect(Object.keys(r)).not.toContain('angle')
    expect(Object.keys(r)).not.toContain('frameId')
    expect(Object.keys(r)).not.toContain('locked')
    for (const v of Object.values(r)) expect(v).not.toBeUndefined()
  })
})

describe('commonBounds', () => {
  it('spans shapes and linear points, ignoring deleted elements', () => {
    expect(commonBounds([rect, ellipse, arrow, deleted])).toEqual({
      x: 10,
      y: 20,
      width: 490,
      height: 100
    })
  })
  it('is null for nothing visible', () => {
    expect(commonBounds([])).toBeNull()
    expect(commonBounds([deleted])).toBeNull()
  })
  it('accounts for rotation', () => {
    const rotated = el({
      id: 'q',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      angle: Math.PI / 2
    })
    const b = commonBounds([rotated])!
    expect(b.width).toBeCloseTo(50)
    expect(b.height).toBeCloseTo(100)
    expect(b.x).toBeCloseTo(25)
    expect(b.y).toBeCloseTo(-25)
  })
})

describe('planDelete', () => {
  it('expands to bound labels and patches arrows and containers', () => {
    const plan = planDelete(['r1'], scene)
    expect(plan.deleted.sort()).toEqual(['r1', 't1'])
    expect(plan.missing).toEqual([])
    expect(plan.patches.get('a1')).toEqual({ startBinding: null })
    expect(plan.patches.has('e1')).toBe(false)
  })
  it('strips deleted ids from boundElements and clears frame membership', () => {
    const plan = planDelete(['a1', 'f1'], scene)
    expect(plan.deleted.sort()).toEqual(['a1', 'f1'])
    expect(plan.patches.get('r1')).toEqual({ boundElements: [{ id: 't1', type: 'text' }] })
    expect(plan.patches.get('e1')).toEqual({ boundElements: null })
    expect(plan.patches.get('m1')).toEqual({ frameId: null })
  })
  it('reports unknown and already-deleted ids as missing', () => {
    const plan = planDelete(['nope', 'gone'], scene)
    expect(plan.deleted).toEqual([])
    expect(plan.missing).toEqual(['nope', 'gone'])
    expect(plan.patches.size).toBe(0)
  })
})

describe('applyPatch', () => {
  it('strips read-only keys and keeps the rest', () => {
    const { changes, textChanged } = applyPatch(rect, {
      id: 'r1',
      type: 'ellipse',
      version: 99,
      versionNonce: 1,
      updated: 1,
      seed: 1,
      index: 'a0',
      isDeleted: true,
      boundElements: [],
      containerId: 'x',
      x: 5,
      strokeColor: '#ff0000',
      opacity: undefined
    })
    expect(changes).toEqual({ x: 5, strokeColor: '#ff0000' })
    expect(textChanged).toBe(false)
  })
  it('sets originalText with text and flags the re-measure', () => {
    const { changes, textChanged } = applyPatch(label, { id: 't1', text: 'New' })
    expect(changes).toEqual({ text: 'New', originalText: 'New' })
    expect(textChanged).toBe(true)
    expect(applyPatch(label, { id: 't1', fontSize: 28 }).textChanged).toBe(true)
    expect(applyPatch(label, { id: 't1', x: 1 }).textChanged).toBe(false)
  })
  it('derives width and height from new points', () => {
    const { changes } = applyPatch(arrow, {
      id: 'a1',
      points: [
        [0, 0],
        [30, -40]
      ]
    })
    expect(changes).toMatchObject({ width: 30, height: 40 })
  })
  it('rejects unknown keys, keys for other types and bad values', () => {
    expect(() => applyPatch(rect, { id: 'r1', bogus: 1 })).toThrowError(/unknown key "bogus"/)
    expect(() => applyPatch(rect, { id: 'r1', text: 'x' })).toThrowError(
      /does not apply to a rectangle/
    )
    expect(() => applyPatch(rect, { id: 'r1', x: 'ten' })).toThrowError(/invalid value for "x"/)
    try {
      applyPatch(rect, { id: 'r1', x: NaN })
    } catch (err) {
      expect(isAgentError(err)).toBe(true)
      expect((err as { code: string }).code).toBe('BAD_PARAMS')
    }
  })
})

describe('validateSkeletons', () => {
  const existing = new Set(['r1', 'e1'])

  it('accepts a well-formed batch and strips Excalidraw-owned keys', () => {
    const out = validateSkeletons(
      [
        {
          type: 'rectangle',
          id: 'n1',
          x: 0,
          y: 0,
          label: { text: 'Hi' },
          version: 7,
          isDeleted: true
        },
        { type: 'arrow', start: { id: 'n1' }, end: { id: 'e1' } },
        { type: 'text', x: 1, y: 2, text: 'free' },
        { type: 'frame', children: ['n1', 'r1'] }
      ],
      existing
    )
    expect(out).toHaveLength(4)
    expect(out[0]).toEqual({ type: 'rectangle', id: 'n1', x: 0, y: 0, label: { text: 'Hi' } })
  })

  it('rejects unknown types', () => {
    expect(() => validateSkeletons([{ type: 'freedraw', x: 0, y: 0 }], existing)).toThrowError(
      /unsupported type/
    )
    expect(() => validateSkeletons([{ x: 0, y: 0 }], existing)).toThrowError(/unsupported type/)
  })

  it('rejects id collisions with the scene and within the batch', () => {
    expect(() =>
      validateSkeletons([{ type: 'rectangle', id: 'r1', x: 0, y: 0 }], existing)
    ).toThrowError(/already exists/)
    expect(() =>
      validateSkeletons(
        [
          { type: 'rectangle', id: 'dup', x: 0, y: 0 },
          { type: 'ellipse', id: 'dup', x: 0, y: 0 }
        ],
        existing
      )
    ).toThrowError(/duplicate id/)
  })

  it('rejects unknown start/end ids and frame children', () => {
    expect(() =>
      validateSkeletons([{ type: 'arrow', x: 0, y: 0, start: { id: 'ghost' } }], existing)
    ).toThrowError(/start.id "ghost" is unknown/)
    expect(() =>
      validateSkeletons([{ type: 'frame', children: ['ghost'] }], existing)
    ).toThrowError(/child "ghost" is unknown/)
  })

  it('rejects non-numeric or missing x/y except where optional', () => {
    expect(() => validateSkeletons([{ type: 'rectangle', x: '1', y: 0 }], existing)).toThrowError(
      /x and y/
    )
    expect(() => validateSkeletons([{ type: 'text', text: 'a' }], existing)).toThrowError(/x and y/)
    expect(() =>
      validateSkeletons([{ type: 'arrow', start: { id: 'r1' } }], existing)
    ).toThrowError(/x and y/)
    expect(() =>
      validateSkeletons([{ type: 'arrow', start: { id: 'r1' }, end: { id: 'e1' } }], existing)
    ).not.toThrow()
  })

  it('rejects empty batches and ill-formed entries', () => {
    expect(() => validateSkeletons([], existing)).toThrowError(/non-empty/)
    expect(() => validateSkeletons('nope', existing)).toThrowError(/non-empty/)
    expect(() => validateSkeletons([{ type: 'text', x: 0, y: 0 }], existing)).toThrowError(
      /"text" string/
    )
    expect(() => validateSkeletons([{ type: 'image', x: 0, y: 0 }], existing)).toThrowError(
      /fileId/
    )
    expect(() =>
      validateSkeletons([{ type: 'line', x: 0, y: 0, label: { text: 'x' } }], existing)
    ).toThrowError(/cannot have a label/)
  })
})

describe('validateIds', () => {
  it('dedupes and rejects bad input', () => {
    expect(validateIds(['a', 'b', 'a'])).toEqual(['a', 'b'])
    expect(() => validateIds([])).toThrowError(/non-empty/)
    expect(() => validateIds(['ok', 3])).toThrowError(/invalid id/)
  })
})

describe('prepareSkeletons', () => {
  const existing = new Map<string, ExcalidrawElement>([
    ['r1', rect],
    ['e1', ellipse]
  ])
  let n = 0
  const makeId = (): string => `gen${++n}`

  it('assigns ids, lifts id bindings out and defers unplaced bound arrows', () => {
    const out = prepareSkeletons(
      [
        { type: 'rectangle', id: 'n1', x: 0, y: 0 },
        { type: 'arrow', start: { id: 'n1' }, end: { id: 'e1' }, label: { text: 'go' } },
        { type: 'arrow', x: 5, y: 5, start: { id: 'r1' }, end: { type: 'ellipse' } }
      ],
      existing,
      makeId
    )
    expect(out.skeletons.map((s) => s.id)).toEqual(['n1', 'gen2'])
    expect(out.skeletons[1]).toEqual({
      type: 'arrow',
      id: 'gen2',
      x: 5,
      y: 5,
      end: { type: 'ellipse' }
    })
    expect(out.routed).toEqual([{ type: 'arrow', id: 'gen1', label: { text: 'go' } }])
    expect(out.bindings).toEqual([
      { arrowId: 'gen1', side: 'start', targetId: 'n1' },
      { arrowId: 'gen1', side: 'end', targetId: 'e1' },
      { arrowId: 'gen2', side: 'start', targetId: 'r1' }
    ])
  })

  it('moves pre-existing frame children and routed arrows out of the converter batch', () => {
    const out = prepareSkeletons(
      [
        { type: 'rectangle', id: 'n1', x: 0, y: 0 },
        { type: 'arrow', id: 'a9', start: { id: 'n1' }, end: { id: 'r1' } },
        { type: 'frame', id: 'f9', children: ['n1', 'r1', 'a9'] }
      ],
      existing,
      makeId
    )
    expect(out.skeletons.find((s) => s.id === 'f9')?.children).toEqual(['n1'])
    expect(out.frameMembers).toEqual([
      { id: 'r1', frameId: 'f9' },
      { id: 'a9', frameId: 'f9' }
    ])
    expect(out.frameBoxes.size).toBe(0)
  })

  it('keeps explicit frame boxes and requires one for frames with no new children', () => {
    const out = prepareSkeletons(
      [{ type: 'frame', id: 'f9', x: 0, y: 0, width: 50, height: 60, children: ['r1'] }],
      existing,
      makeId
    )
    expect(out.frameBoxes.get('f9')).toEqual({ x: 0, y: 0, width: 50, height: 60 })
    expect(() =>
      prepareSkeletons([{ type: 'frame', id: 'f8', children: ['r1'] }], existing, makeId)
    ).toThrowError(/give it x, y, width and height/)
  })
})

describe('routeArrow and arrowBinding', () => {
  it('routes centre to centre, trimmed to the outlines plus the gap', () => {
    const a = el({ id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 })
    const b = el({ id: 'b', type: 'rectangle', x: 300, y: 0, width: 100, height: 100 })
    const geo = routeArrow(a, b)
    expect(geo.x).toBe(100 + ROUTE_GAP)
    expect(geo.y).toBe(50)
    expect(geo.points).toEqual([
      [0, 0],
      [200 - 2 * ROUTE_GAP, 0]
    ])
  })
  it('leaves an ellipse along its outline', () => {
    const a = el({ id: 'a', type: 'ellipse', x: 0, y: 0, width: 100, height: 50 })
    const b = el({ id: 'b', type: 'rectangle', x: 50, y: 300, width: 0, height: 0 })
    const geo = routeArrow(a, b)
    expect(geo.x).toBe(50)
    expect(geo.y).toBe(25 + 25 + ROUTE_GAP)
  })
  it('falls back to centre-to-centre when shapes overlap', () => {
    const a = el({ id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 })
    const b = el({ id: 'b', type: 'rectangle', x: 20, y: 20, width: 100, height: 100 })
    expect(routeArrow(a, b)).toEqual({
      x: 50,
      y: 50,
      points: [
        [0, 0],
        [20, 20]
      ]
    })
  })
  it('builds bindings aimed at the target centre with the measured gap', () => {
    const arrowEl = el({
      id: 'ar',
      type: 'arrow',
      x: 110,
      y: 50,
      points: [
        [0, 0],
        [100, 0]
      ]
    } as Partial_) as ExcalidrawElement & { points: [number, number][] }
    const target = el({ id: 'tg', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 })
    expect(arrowBinding(arrowEl as never, 'start', target)).toEqual({
      elementId: 'tg',
      focus: 0,
      gap: 10
    })
    expect(arrowBinding(arrowEl as never, 'start', target, ROUTE_GAP)).toEqual({
      elementId: 'tg',
      focus: 0,
      gap: ROUTE_GAP
    })
    const line = el({ id: 'ln', type: 'line' })
    expect(() => arrowBinding(arrowEl as never, 'end', line)).toThrowError(
      /cannot bind end to a line/
    )
  })
})
