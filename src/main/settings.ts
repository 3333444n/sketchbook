// Pure settings store (no 'electron' import) so it can be unit tested in node.
// Main keeps it at `userData/settings.json`; the bundled MCP server reads the
// same file to tell "bridge disabled" from "app not running".
import { promises as fs } from 'fs'
import { atomicWrite } from './fileio'

export type Settings = {
  /** Whether the local agent bridge (Unix socket + pointer file) is started. */
  allowAgentConnections: boolean
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  allowAgentConnections: false
})

/**
 * Read settings from `file`. A missing or corrupt file, or a value of the wrong
 * type, yields the defaults for the affected keys. Unknown keys are dropped.
 */
export async function readSettings(file: string): Promise<Settings> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  return fromUnknown(parsed)
}

/** Merge `patch` into the current settings and write the result atomically. */
export async function writeSettings(file: string, patch: Partial<Settings>): Promise<Settings> {
  const next = fromUnknown({ ...(await readSettings(file)), ...patch })
  await atomicWrite(file, JSON.stringify(next, null, 2) + '\n')
  return next
}

function fromUnknown(value: unknown): Settings {
  const obj = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return {
    allowAgentConnections:
      typeof obj.allowAgentConnections === 'boolean'
        ? obj.allowAgentConnections
        : DEFAULT_SETTINGS.allowAgentConnections
  }
}
