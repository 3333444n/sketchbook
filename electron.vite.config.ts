import { readFileSync } from 'fs'
import { join, relative, resolve } from 'path'
import { defineConfig } from 'electron-vite'
import { normalizePath, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

/**
 * The production CSP lives in src/renderer/index.html. The Vite dev server needs
 * an inline react-refresh preamble and an HMR websocket, so in `serve` mode only
 * we swap in a relaxed policy. Production builds are untouched.
 */
function devCsp(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob: ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'"
  ].join('; ')
  return {
    name: 'sketchbook-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/,
        `$1${policy}$2`
      )
    }
  }
}

/**
 * Excalidraw registers every font face with two sources: our bundled copy
 * (EXCALIDRAW_ASSET_PATH) and a CDN fallback (https://esm.sh/...). Offline the
 * fallback is useless and it trips the CSP (`font-src 'self'`) on every face.
 * Strip the fallback `urls.push(new URL(x, Foo.ASSETS_FALLBACK_URL))` call.
 * Fails the build loudly if a future Excalidraw version changes the code shape.
 */
const FALLBACK_PUSH =
  /\b[\w$]+\.push\(\s*new URL\(\s*[\w$]+\s*,\s*[\w$]+\.ASSETS_FALLBACK_URL\s*\)\s*\)/g
const EXCALIDRAW_DIST = /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/](prod|dev)[\\/][^\\/]+\.js$/

/**
 * Excalidraw's font subsetting (used when exporting) runs Emscripten/embind
 * glue that builds tiny forwarding functions with `new Function(...)`, which
 * our CSP (no 'unsafe-eval') forbids. Replace both helpers with equivalent
 * closures so subsetting works under `script-src 'self' 'wasm-unsafe-eval'`.
 */
// embind createNamedFunction(name, body)
const EMBIND_NAMED =
  /new Function\(\s*"body"\s*,\s*`return function \$\{([\w$]+)\}\(\) \{\s*"use strict";\s*return body\.apply\(this, arguments\);\s*\};\s*`\s*\)\(\s*([\w$]+)\s*\)/g
const EMBIND_NAMED_REPLACEMENT =
  '((n,b)=>{const f=function(){return b.apply(this,arguments)};try{Object.defineProperty(f,"name",{value:n})}catch(e){}return f})($1,$2)'
// embind makeDynCaller: new Function("dynCall", "rawFunction", body)(dynCall, rawFunction)
const EMBIND_DYNCALL =
  /new Function\(\s*"dynCall"\s*,\s*"rawFunction"\s*,\s*[\w$]+\s*\)\(\s*([\w$]+)\s*,\s*([\w$]+)\s*\)/g
const EMBIND_DYNCALL_REPLACEMENT = '(function(){return $1($2,...arguments)})'

function replaceOrThrow(
  code: string,
  re: RegExp,
  replacement: string | (() => string),
  what: string,
  id: string
): string {
  let count = 0
  const out = code.replace(re, (...args) => {
    count++
    if (typeof replacement === 'function') return replacement()
    // Expand $1.. against this match.
    return replacement.replace(/\$(\d)/g, (_m, n) => String(args[Number(n)]))
  })
  if (count === 0) {
    throw new Error(
      `[sketchbook] could not patch ${what} in ${id}; Excalidraw changed — update electron.vite.config.ts`
    )
  }
  return out
}

function patchExcalidraw(code: string, id: string): string | null {
  if (!EXCALIDRAW_DIST.test(id.split('?')[0])) return null
  let out = code
  if (out.includes('ASSETS_FALLBACK_URL')) {
    out = replaceOrThrow(out, FALLBACK_PUSH, () => '0', 'the CDN font fallback', id)
  }
  if (out.includes('new Function')) {
    if (out.includes('"use strict";    return body.apply')) {
      out = replaceOrThrow(
        out,
        EMBIND_NAMED,
        EMBIND_NAMED_REPLACEMENT,
        'embind createNamedFunction',
        id
      )
    }
    if (/"dynCall"\s*,\s*"rawFunction"/.test(out)) {
      out = replaceOrThrow(out, EMBIND_DYNCALL, EMBIND_DYNCALL_REPLACEMENT, 'embind dynCall', id)
    }
    if (out.includes('new Function')) {
      throw new Error(`[sketchbook] unexpected eval (new Function) left in ${id}`)
    }
  }
  return out === code ? null : out
}

function excalidrawOffline(): Plugin {
  return {
    name: 'sketchbook-excalidraw-offline',
    enforce: 'pre',
    transform(code, id) {
      const out = patchExcalidraw(code, id)
      return out === null ? null : { code: out, map: null }
    }
  }
}

// Excalidraw requests fonts from `${EXCALIDRAW_ASSET_PATH}fonts/<Family>/<file>.woff2`.
// Copy them into the renderer output (and serve them in dev) so they load from app://bundle/fonts/.
const excalidrawFonts = normalizePath(
  relative(resolve('src/renderer'), resolve('node_modules/@excalidraw/excalidraw/dist/prod/fonts'))
)

/**
 * Excalidraw's font-subsetting worker (subset-worker.chunk.js) must not import
 * the main app chunk, which touches `window` at top level and would crash the
 * worker (Excalidraw then falls back to subsetting on the main thread, where
 * the embind glue needs `eval` — blocked by our CSP). Collect the worker's
 * static import closure from the published dist and pin those modules into
 * their own chunk, shared by the worker and the main app.
 */
function subsetWorkerDeps(): string[] {
  const dir = resolve('node_modules/@excalidraw/excalidraw/dist/prod')
  const seen = new Set<string>()
  const visit = (file: string): void => {
    const src = readFileSync(join(dir, file), 'utf8')
    for (const m of src.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) {
      if (!seen.has(m[1])) {
        seen.add(m[1])
        visit(m[1])
      }
    }
  }
  visit('subset-worker.chunk.js')
  if (seen.size === 0) throw new Error('[sketchbook] could not find subset-worker dependencies')
  return [...seen]
}
const SUBSET_DEPS = subsetWorkerDeps()
const SUBSET_DEPS_RE = new RegExp(
  `[\\\\/]@excalidraw[\\\\/]excalidraw[\\\\/]dist[\\\\/]prod[\\\\/](${SUBSET_DEPS.map((f) =>
    f.replace(/[.]/g, '\\.')
  ).join('|')})$`
)

export default defineConfig({
  // Bundle main/preload dependencies into out/ so the packaged app needs no
  // node_modules at all (electron-builder.yml excludes them; the renderer is
  // fully bundled by Vite). Keeps the .app small and self-contained.
  main: { build: { externalizeDeps: false } },
  preload: { build: { externalizeDeps: false } },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [{ name: 'excalidraw-subset', test: SUBSET_DEPS_RE }]
          }
        }
      }
    },
    // In dev, Excalidraw is pre-bundled by the dep optimizer, which bypasses
    // normal plugin transforms — apply the same rewrite there.
    optimizeDeps: {
      rolldownOptions: {
        plugins: [
          {
            name: 'sketchbook-excalidraw-offline-deps',
            transform(code: string, id: string) {
              const out = patchExcalidraw(code, id)
              return out === null ? null : { code: out, map: null }
            }
          }
        ]
      }
    },
    plugins: [
      react(),
      devCsp(),
      excalidrawOffline(),
      viteStaticCopy({
        targets: [
          {
            // Relative to the renderer root (src/renderer). `..` segments are not
            // counted by stripBase; the 6 stripped are
            // node_modules/@excalidraw/excalidraw/dist/prod/fonts.
            src: `${excalidrawFonts}/**/*.woff2`,
            dest: 'fonts',
            rename: { stripBase: 6 }
          }
        ]
      })
    ]
  }
})
