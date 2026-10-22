// Finder / command-line integration: single instance, `open-file`, argv paths.
import { app } from 'electron'
import { existsSync, statSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { isOpenable, isNativeScene } from './fileio'

type OpenFn = (paths: string[]) => void

let ready = false
let opener: OpenFn | null = null
const queue: string[] = []

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

/** File paths in an argv list (skips flags and the executable/app path). */
export function pathsFromArgv(
  argv: string[],
  cwd: string,
  accept: (p: string) => boolean = isOpenable
): string[] {
  const out: string[] = []
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue
    const p = isAbsolute(arg) ? arg : resolve(cwd, arg)
    if (accept(p) && isFile(p)) out.push(p)
  }
  return out
}

/**
 * Must be called before `ready`. Returns false if another instance owns the
 * lock (this instance is quitting and should do nothing else).
 */
export function initFinder(onFocus: () => void): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }
  app.on('open-file', (e, path) => {
    e.preventDefault()
    if (ready && opener) opener([path])
    else queue.push(path)
  })
  app.on('second-instance', (_e, argv, cwd) => {
    const paths = pathsFromArgv(argv, cwd)
    if (paths.length && opener) opener(paths)
    else onFocus()
  })
  return true
}

/**
 * Call once on ready with the function that opens paths. Returns the paths
 * queued from Finder plus any `.excalidraw` passed on the launch command line.
 */
export function finderReady(open: OpenFn): string[] {
  opener = open
  ready = true
  const launch = pathsFromArgv(process.argv, process.cwd(), isNativeScene)
  const all = [...queue.splice(0), ...launch]
  return [...new Set(all)]
}
