/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Regenerates the README screenshots in docs/images/ from the production build.
//
//   pnpm screenshots        (builds first, then runs this script)
//
// It writes three sample .excalidraw scenes to a temp folder, launches
// out/main/index.js with Playwright's `_electron` and an isolated --user-data-dir,
// opens the scenes from argv as tabs, and captures each shot at 1440×900 with a
// device scale factor of 2. page.screenshot only sees web content, so the macOS
// traffic lights (drawn by the OS) are painted back in, together with a window
// frame and shadow, on a canvas inside the app's own page. If `pngquant` is on
// PATH the images are compressed with it.

import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = join(ROOT, 'out/main/index.js')
const OUT = join(ROOT, 'docs/images')
const MENU_CHANNEL = 'win:menu-action' // IPC.menu in src/shared/ipc.ts

const WIDTH = 1440
const HEIGHT = 900
const SCALE = 2
const STRIP = 40 // TAB_STRIP_HEIGHT in src/shared/chrome.ts

// ---- sample scenes ------------------------------------------------------------

// Excalidraw palette (open-color): stroke / background pairs.
const C = {
  ink: '#1e1e1e',
  gray: '#868e96',
  blue: ['#1971c2', '#a5d8ff'],
  green: ['#2f9e44', '#b2f2bb'],
  violet: ['#6741d9', '#d0bfff'],
  orange: ['#f08c00', '#ffec99'],
  red: ['#e03131', '#ffc9c9'],
  teal: ['#099268', '#96f2d7']
}

const EXCALIFONT = 5
let counter = 0

function base(type, x, y, width, height, o = {}) {
  counter++
  return {
    id: o.id ?? `${type}-${counter}`,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: o.stroke ?? C.ink,
    backgroundColor: o.bg ?? 'transparent',
    fillStyle: o.fill ?? 'solid',
    strokeWidth: o.strokeWidth ?? 2,
    strokeStyle: o.strokeStyle ?? 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: o.roundness ?? null,
    seed: 1000 + counter * 7919,
    version: 1,
    versionNonce: 2000 + counter * 104729,
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false
  }
}

/** Rough text metrics for Excalifont; Excalidraw re-measures once fonts load. */
function measure(text, fontSize) {
  const lines = text.split('\n')
  const longest = Math.max(...lines.map((l) => l.length))
  return { width: Math.ceil(longest * fontSize * 0.55), height: lines.length * fontSize * 1.25 }
}

function text(x, y, str, o = {}) {
  const fontSize = o.fontSize ?? 20
  const m = measure(str, fontSize)
  return {
    ...base('text', x, y, m.width, m.height, { stroke: o.stroke ?? C.ink }),
    text: str,
    originalText: str,
    fontSize,
    fontFamily: EXCALIFONT,
    textAlign: o.align ?? 'left',
    verticalAlign: o.valign ?? 'top',
    containerId: o.containerId ?? null,
    autoResize: true,
    lineHeight: 1.25
  }
}

/** A shape with an optional centred label. Returns [shape, label?]. */
function shape(type, x, y, w, h, o = {}) {
  const [stroke, bg] = o.color ?? [C.ink, 'transparent']
  const el = base(type, x, y, w, h, {
    stroke,
    bg,
    strokeStyle: o.strokeStyle,
    fill: o.fill,
    roundness: type === 'rectangle' ? { type: 3 } : type === 'diamond' ? { type: 2 } : null
  })
  el.id = o.id ?? el.id
  const out = [el]
  if (o.label) {
    const fontSize = o.fontSize ?? 20
    const m = measure(o.label, fontSize)
    const t = text(x + (w - m.width) / 2, y + (h - m.height) / 2, o.label, {
      fontSize,
      align: 'center',
      valign: 'middle',
      containerId: el.id,
      stroke: o.textColor ?? C.ink
    })
    el.boundElements.push({ type: 'text', id: t.id })
    out.push(t)
  }
  return out
}

const rect = (...a) => shape('rectangle', ...a)
const ellipse = (...a) => shape('ellipse', ...a)
const diamond = (...a) => shape('diamond', ...a)

/** Anchor point on a side of a shape: 'l', 'r', 't', 'b', with optional offset along it. */
function anchor(el, side, along = 0.5) {
  const { x, y, width: w, height: h } = el
  switch (side) {
    case 'l':
      return [x, y + h * along]
    case 'r':
      return [x + w, y + h * along]
    case 't':
      return [x + w * along, y]
    case 'b':
      return [x + w * along, y + h]
  }
}

const GAP = 8

function nudge([px, py], side, d) {
  return side === 'l'
    ? [px - d, py]
    : side === 'r'
      ? [px + d, py]
      : side === 't'
        ? [px, py - d]
        : [px, py + d]
}

/**
 * An arrow from one shape's side to another's, bound at both ends.
 * `via` adds intermediate points (absolute) and makes the arrow curved.
 */
function arrow(from, fromSide, to, toSide, o = {}) {
  const a = nudge(anchor(from, fromSide, o.fromAlong), fromSide, GAP)
  const b = nudge(anchor(to, toSide, o.toAlong), toSide, GAP)
  const pts = [a, ...(o.via ?? []), b]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const el = base(
    'arrow',
    a[0],
    a[1],
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
    {
      stroke: o.stroke ?? C.ink,
      strokeStyle: o.strokeStyle,
      strokeWidth: o.strokeWidth,
      roundness: o.via ? { type: 2 } : null
    }
  )
  Object.assign(el, {
    points: pts.map(([px, py]) => [px - a[0], py - a[1]]),
    lastCommittedPoint: null,
    startBinding: { elementId: from.id, focus: 0, gap: GAP },
    endBinding: { elementId: to.id, focus: 0, gap: GAP },
    startArrowhead: null,
    endArrowhead: o.head === undefined ? 'arrow' : o.head,
    elbowed: false
  })
  from.boundElements.push({ type: 'arrow', id: el.id })
  to.boundElements.push({ type: 'arrow', id: el.id })
  const out = [el]
  if (o.label) {
    const fontSize = o.fontSize ?? 16
    const m = measure(o.label, fontSize)
    const mid = pts[Math.floor(pts.length / 2)]
    const midPt = pts.length % 2 ? mid : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const t = text(midPt[0] - m.width / 2, midPt[1] - m.height / 2, o.label, {
      fontSize,
      align: 'center',
      valign: 'middle',
      containerId: el.id,
      stroke: o.stroke ?? C.ink
    })
    el.boundElements.push({ type: 'text', id: t.id })
    out.push(t)
  }
  return out
}

/** An unbound plain line between two absolute points (mind-map leaves). */
function line(a, b, stroke, via) {
  const pts = [a, ...(via ?? []), b]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const el = base(
    'line',
    a[0],
    a[1],
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
    {
      stroke,
      strokeWidth: 1,
      roundness: via ? { type: 2 } : null
    }
  )
  return Object.assign(el, {
    points: pts.map(([px, py]) => [px - a[0], py - a[1]]),
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null
  })
}

function scene(elements) {
  return JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      source: 'sketchbook-screenshots',
      elements,
      appState: { viewBackgroundColor: '#ffffff', gridSize: 20 },
      files: {}
    },
    null,
    2
  )
}

function architecture() {
  const els = []
  const add = (arr) => (els.push(...arr), arr[0])
  els.push(text(0, -110, 'Photo app — system sketch', { fontSize: 36 }))
  els.push(
    text(2, -58, 'draft v3 · everything behind the gateway is private', {
      fontSize: 18,
      stroke: C.gray
    })
  )

  const mobile = add(rect(0, 100, 200, 80, { color: C.blue, label: 'Mobile app' }))
  const web = add(rect(0, 240, 200, 80, { color: C.blue, label: 'Web app' }))
  const gateway = add(diamond(300, 150, 200, 120, { color: C.violet, label: 'API\ngateway' }))
  const auth = add(rect(620, 40, 200, 70, { color: C.green, label: 'Auth service' }))
  const uploads = add(rect(620, 175, 200, 70, { color: C.green, label: 'Upload service' }))
  const feed = add(rect(620, 310, 200, 70, { color: C.green, label: 'Feed service' }))
  const db = add(ellipse(940, 25, 220, 100, { color: C.orange, label: 'Database' }))
  const storage = add(rect(940, 175, 220, 70, { color: C.orange, label: 'Object storage' }))
  const queue = add(
    rect(940, 310, 220, 70, { color: C.teal, label: 'Job queue', strokeStyle: 'dashed' })
  )
  const worker = add(rect(940, 450, 220, 80, { color: C.red, label: 'Thumbnail\nworker' }))

  els.push(...arrow(mobile, 'r', gateway, 'l', { toAlong: 0.45 }))
  els.push(...arrow(web, 'r', gateway, 'l', { toAlong: 0.55 }))
  els.push(...arrow(gateway, 't', auth, 'l', { via: [[400, 75]] }))
  els.push(...arrow(gateway, 'r', uploads, 'l'))
  els.push(...arrow(gateway, 'b', feed, 'l', { via: [[400, 345]] }))
  els.push(...arrow(auth, 'r', db, 'l', { fromAlong: 0.5, toAlong: 0.5 }))
  els.push(...arrow(uploads, 'r', storage, 'l'))
  els.push(...arrow(uploads, 'b', queue, 'l', { fromAlong: 0.75, via: [[800, 290]], toAlong: 0.4 }))
  els.push(...arrow(queue, 'b', worker, 't'))
  els.push(
    ...arrow(worker, 'r', storage, 'r', {
      via: [[1230, 360]],
      label: 'thumbnails',
      stroke: C.red[0],
      strokeStyle: 'dashed'
    })
  )

  els.push(
    ...rect(0, 420, 300, 110, {
      color: [C.orange[0], '#fff3bf'],
      label: 'TODO: rate limits\nat the gateway',
      fontSize: 20
    })
  )
  return scene(els)
}

function checkout() {
  const els = []
  const add = (arr) => (els.push(...arr), arr[0])
  els.push(text(0, -120, 'Checkout flow', { fontSize: 36 }))
  els.push(
    text(2, -70, 'happy path first, edge cases on the right', { fontSize: 18, stroke: C.gray })
  )

  const start = add(ellipse(0, 0, 140, 70, { color: C.green, label: 'Start' }))
  const browse = add(rect(200, 0, 160, 70, { color: C.blue, label: 'Browse' }))
  const cart = add(rect(420, 0, 160, 70, { color: C.blue, label: 'Add to cart' }))
  const signedIn = add(diamond(640, -25, 180, 120, { color: C.violet, label: 'Signed\nin?' }))
  const signIn = add(rect(640, 190, 180, 80, { color: C.violet, label: 'Sign in /\nsign up' }))
  const pay = add(rect(900, 0, 170, 70, { color: C.orange, label: 'Payment' }))
  const ok = add(diamond(895, 130, 180, 120, { color: C.orange, label: 'Card\nOK?' }))
  const done = add(ellipse(880, 320, 210, 90, { color: C.green, label: 'Order\nconfirmed' }))
  const error = add(rect(1150, 155, 170, 70, { color: C.red, label: 'Show error' }))

  els.push(...arrow(start, 'r', browse, 'l'))
  els.push(...arrow(browse, 'r', cart, 'l'))
  els.push(...arrow(cart, 'r', signedIn, 'l'))
  els.push(...arrow(signedIn, 'r', pay, 'l', { label: 'yes' }))
  els.push(...arrow(signedIn, 'b', signIn, 't', { label: 'no' }))
  els.push(...arrow(signIn, 'r', pay, 'b', { via: [[880, 200]], toAlong: 0.2 }))
  els.push(...arrow(pay, 'b', ok, 't', { fromAlong: 0.55 }))
  els.push(...arrow(ok, 'b', done, 't', { label: 'yes' }))
  els.push(...arrow(ok, 'r', error, 'l', { label: 'no' }))
  els.push(
    ...arrow(error, 't', pay, 'r', {
      via: [[1200, 45]],
      label: 'retry',
      stroke: C.red[0],
      strokeStyle: 'dashed'
    })
  )
  els.push(text(600, 300, 'guest checkout?\n→ later', { fontSize: 18, stroke: C.gray }))
  return scene(els)
}

function tripIdeas() {
  const els = []
  const add = (arr) => (els.push(...arr), arr[0])
  const center = add(
    ellipse(500, 270, 240, 110, { color: C.violet, label: 'Trip ideas', fontSize: 32 })
  )
  const branches = [
    {
      label: 'Mountains',
      color: C.green,
      at: [170, 90],
      leaves: ['hut-to-hut hike', 'lake swim at dawn'],
      side: 'l'
    },
    {
      label: 'Coast',
      color: C.blue,
      at: [920, 90],
      leaves: ['sea kayaking', 'lighthouse walk'],
      side: 'r'
    },
    {
      label: 'City break',
      color: C.orange,
      at: [150, 470],
      leaves: ['night market', 'old town by bike'],
      side: 'l'
    },
    {
      label: 'Food',
      color: C.red,
      at: [940, 470],
      leaves: ['cooking class', 'try every bakery'],
      side: 'r'
    }
  ]
  for (const b of branches) {
    const w = 170
    const node = add(
      rect(b.at[0], b.at[1], w, 64, { color: b.color, label: b.label, fontSize: 24 })
    )
    const top = b.at[1] < 270
    const fromSide = top ? 't' : 'b'
    const toSide = b.side === 'l' ? 'r' : 'l'
    const cx = center.x + center.width * (b.side === 'l' ? 0.3 : 0.7)
    const mid = [
      (cx + (b.side === 'l' ? b.at[0] + w : b.at[0])) / 2,
      top ? b.at[1] + 64 + 10 : b.at[1] - 10
    ]
    els.push(
      ...arrow(center, fromSide, node, toSide, {
        fromAlong: b.side === 'l' ? 0.3 : 0.7,
        via: [mid],
        stroke: b.color[0],
        head: null,
        strokeWidth: 2
      })
    )
    b.leaves.forEach((leaf, i) => {
      const ly = b.at[1] + (top ? -70 + i * 60 : 40 + i * 60)
      const lx = b.side === 'l' ? b.at[0] - 190 : b.at[0] + w + 40
      const t = text(lx, ly, leaf, { fontSize: 20, stroke: b.color[0] })
      els.push(t)
      const from = b.side === 'l' ? [b.at[0] - 6, b.at[1] + 32] : [b.at[0] + w + 6, b.at[1] + 32]
      const to = b.side === 'l' ? [lx + t.width + 8, ly + 12] : [lx - 8, ly + 12]
      els.push(line(from, to, b.color[0], [[(from[0] + to[0]) / 2, from[1] * 0.3 + to[1] * 0.7]]))
    })
  }
  els.push(
    ...rect(500, 470, 240, 130, {
      color: [C.orange[0], '#fff3bf'],
      label: 'pack:\nrain jacket\nfilm camera\nsnacks!',
      fontSize: 20
    })
  )
  els.push(text(560, 30, 'when? spring or early autumn', { fontSize: 18, stroke: C.gray }))
  return scene(els)
}

// ---- window frame compositing ------------------------------------------------

/**
 * Runs in the renderer: paints `png` (base64) into a rounded window with traffic
 * lights and a soft shadow on a transparent background. Returns base64 PNG.
 */
async function composite({ png, scale, pad, radius, theme, shadow, lights, outScale }) {
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
  const img = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const k = outScale / scale // source px -> output px
  const s = outScale // css px -> output px
  const w = img.width * k
  const h = img.height * k
  const p = pad * s
  const canvas = new OffscreenCanvas(Math.round(w + 2 * p), Math.round(h + 2 * p))
  const ctx = canvas.getContext('2d')
  const r = radius * s
  const window = () => {
    ctx.beginPath()
    ctx.roundRect(p, p, w, h, r)
  }

  // Shadow: a wide soft one plus a tight contact one.
  for (const [blur, y, alpha] of shadow) {
    ctx.save()
    window()
    ctx.shadowColor = `rgba(0, 0, 0, ${alpha})`
    ctx.shadowBlur = blur * s
    ctx.shadowOffsetY = y * s
    ctx.fillStyle = theme === 'dark' ? '#121212' : '#ffffff'
    ctx.fill()
    ctx.restore()
  }

  ctx.save()
  window()
  ctx.clip()
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, p, p, w, h)
  ctx.restore()

  if (lights) {
    const colors = ['#ff5f57', '#febc2e', '#28c840']
    colors.forEach((color, i) => {
      ctx.beginPath()
      ctx.arc(p + (14 + 6 + i * 20) * s, p + 20 * s, 6 * s, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.lineWidth = 0.5 * s
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)'
      ctx.stroke()
    })
  }

  // Hairline border, like a macOS window edge.
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(p + 0.5 * s, p + 0.5 * s, w - s, h - s, r - 0.5 * s)
  ctx.lineWidth = 1 * s
  ctx.strokeStyle = theme === 'dark' ? 'rgba(255, 255, 255, 0.14)' : 'rgba(0, 0, 0, 0.14)'
  ctx.stroke()
  ctx.restore()
  if (theme === 'dark') {
    ctx.beginPath()
    ctx.roundRect(p - 0.5 * s, p - 0.5 * s, w + s, h + s, r + 0.5 * s)
    ctx.lineWidth = 1 * s
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'
    ctx.stroke()
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const buf = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000)
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(bin)
}

// ---- driver ----------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function hasPngquant() {
  try {
    execFileSync('pngquant', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'sketchbook-shots-'))
  const userData = join(work, 'profile')
  const files = [
    ['Photo app architecture.excalidraw', architecture()],
    ['Checkout flow.excalidraw', checkout()],
    ['Trip ideas.excalidraw', tripIdeas()]
  ].map(([name, json]) => {
    const f = join(work, name)
    writeFileSync(f, json)
    return f
  })

  const app = await electron.launch({
    args: [MAIN, `--user-data-dir=${userData}`, ...files],
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_RENDERER_URL: '' }
  })
  const quant = hasPngquant()
  const written = []

  try {
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light'
    })
    const page = await app.firstWindow()
    await app.evaluate(
      ({ BrowserWindow }, [w, h]) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(w, h)
      },
      [WIDTH, HEIGHT]
    )
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: SCALE,
      mobile: false
    })

    await page.locator('.sketchbook-tab').nth(2).waitFor({ timeout: 30_000 })
    await page.locator('canvas.interactive').first().waitFor({ timeout: 30_000 })

    const settle = async (ms = 1200) => {
      await page.evaluate(() => document.fonts.ready)
      await sleep(ms)
    }
    const activate = async (i) => {
      await page.locator('.sketchbook-tab').nth(i).click()
      await page.locator('.sketchbook-editor--active canvas.interactive').waitFor()
      await settle()
    }
    const menu = (action) =>
      app.evaluate(
        ({ BrowserWindow }, [ch, a]) => BrowserWindow.getAllWindows()[0].webContents.send(ch, a),
        [MENU_CHANNEL, action]
      )
    const shot = (opts = {}) => page.screenshot({ type: 'png', ...opts })
    const save = async (name, png) => {
      const file = join(OUT, name)
      writeFileSync(file, png)
      if (quant) {
        execFileSync('pngquant', [
          '--quality=80-98',
          '--speed=1',
          '--strip',
          '--force',
          '--output',
          file,
          file
        ])
      }
      written.push([name, statSync(file).size])
    }
    const framed = async (png, opts) =>
      Buffer.from(
        await page.evaluate(composite, {
          png: png.toString('base64'),
          scale: SCALE,
          pad: 56,
          radius: 10,
          theme: 'light',
          shadow: [
            [60, 24, 0.22],
            [6, 1, 0.12]
          ],
          lights: true,
          outScale: 2,
          ...opts
        }),
        'base64'
      )
    const setTheme = async (t) => {
      await app.evaluate(({ nativeTheme }, theme) => {
        nativeTheme.themeSource = theme
      }, t)
      // The device-metrics override pins media features; set the scheme explicitly too.
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: t }]
      })
      await settle(1500)
    }
    // Keep the mouse off the canvas and tabs so nothing shows hover state.
    const park = () => page.mouse.move(WIDTH - 2, HEIGHT / 2)

    // 1–2. Heroes: the architecture sketch, light and dark.
    await activate(0)
    await park()
    await settle(1500)
    await save('hero-light.png', await framed(await shot(), { theme: 'light' }))
    await setTheme('dark')
    await save('hero-dark.png', await framed(await shot(), { theme: 'dark' }))
    await setTheme('light')

    // 5. Export dialog for the mind map.
    await activate(2)
    await menu('export-image')
    await page.locator('.ImageExportModal').waitFor({ state: 'visible' })
    await park()
    await settle(1500)
    await save('export.png', await framed(await shot()))
    await page.keyboard.press('Escape')
    await page.locator('.ImageExportModal').waitFor({ state: 'detached' })

    // 4. Mermaid to Excalidraw.
    await activate(1)
    await menu('mermaid')
    const ttd = page.locator('.ttd-dialog')
    await ttd.waitFor({ state: 'visible', timeout: 15_000 })
    await ttd
      .locator('textarea')
      .fill(
        [
          'flowchart LR',
          '  A[Idea on a flight] --> B{Worth sketching?}',
          '  B -->|yes| C[Open Sketchbook]',
          '  B -->|later| D[Add to trip ideas]',
          '  C --> E[Save .excalidraw]',
          '  D --> E'
        ].join('\n')
      )
    await ttd.locator('svg').first().waitFor({ state: 'visible', timeout: 15_000 })
    await park()
    await settle(2000)
    await save('mermaid.png', await framed(await shot()))
    await page.keyboard.press('Escape')
    await ttd.waitFor({ state: 'detached' })

    // 3. Tab strip with one unsaved tab: nudge everything in "Trip ideas" and back.
    await activate(2)
    await page.locator('.sketchbook-editor--active .excalidraw-container').focus()
    await page.keyboard.press('Meta+a')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Escape')
    await page.locator('.sketchbook-tab--dirty').waitFor()
    await activate(0)
    await park()
    await settle(600)
    const strip = await page.locator('.sketchbook-tabstrip__new').boundingBox()
    const cropW = Math.ceil(strip.x + strip.width + 120)
    await save(
      'tabs.png',
      await framed(await shot({ clip: { x: 0, y: 0, width: cropW, height: STRIP + 12 } }), {
        pad: 24,
        shadow: [
          [24, 8, 0.16],
          [4, 1, 0.1]
        ]
      })
    )

    // 6. Welcome screen on a fresh tab.
    await page.evaluate(() => window.sketchbook.newTab())
    await page.locator('.sketchbook-tab').nth(3).waitFor()
    await page.locator('.sketchbook-editor--active .welcome-screen-center').waitFor()
    await park()
    await settle(1500)
    await save('welcome.png', await framed(await shot(), { theme: 'light' }))
  } finally {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
        dialog.showMessageBoxSync = () => 1
      })
      .catch(() => undefined)
    await app.close().catch(() => undefined)
    rmSync(work, { recursive: true, force: true })
  }

  for (const [name, size] of written)
    console.log(`${name.padEnd(16)} ${(size / 1024).toFixed(0)} KB`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
