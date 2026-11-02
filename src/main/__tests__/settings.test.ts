import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_SETTINGS, readSettings, writeSettings } from '../settings'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sketchbook-settings-'))
  file = join(dir, 'settings.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readSettings', () => {
  it('returns defaults when the file is missing', async () => {
    expect(await readSettings(file)).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.allowAgentConnections).toBe(false)
  })

  it('returns defaults for corrupt JSON', async () => {
    writeFileSync(file, '{"allowAgentConnections": tru')
    expect(await readSettings(file)).toEqual(DEFAULT_SETTINGS)
  })

  it('returns defaults when the file is not an object', async () => {
    writeFileSync(file, '[true]')
    expect(await readSettings(file)).toEqual(DEFAULT_SETTINGS)
    writeFileSync(file, 'null')
    expect(await readSettings(file)).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back to the default for a non-boolean value', async () => {
    writeFileSync(file, '{"allowAgentConnections": "true"}')
    expect((await readSettings(file)).allowAgentConnections).toBe(false)
    writeFileSync(file, '{"allowAgentConnections": 1}')
    expect((await readSettings(file)).allowAgentConnections).toBe(false)
  })

  it('reads a valid value', async () => {
    writeFileSync(file, '{"allowAgentConnections": true}')
    expect((await readSettings(file)).allowAgentConnections).toBe(true)
  })

  it('drops unknown keys', async () => {
    writeFileSync(file, '{"allowAgentConnections": true, "extra": 42}')
    expect(await readSettings(file)).toEqual({ allowAgentConnections: true })
  })
})

describe('writeSettings', () => {
  it('round-trips through disk', async () => {
    const written = await writeSettings(file, { allowAgentConnections: true })
    expect(written).toEqual({ allowAgentConnections: true })
    expect(await readSettings(file)).toEqual({ allowAgentConnections: true })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ allowAgentConnections: true })
    // atomicWrite leaves no temp file behind
    expect(readdirSync(dir)).toEqual(['settings.json'])

    await writeSettings(file, { allowAgentConnections: false })
    expect(await readSettings(file)).toEqual({ allowAgentConnections: false })
  })

  it('drops unknown keys already on disk when writing', async () => {
    writeFileSync(file, '{"allowAgentConnections": false, "legacy": "x"}')
    await writeSettings(file, { allowAgentConnections: true })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ allowAgentConnections: true })
  })

  it('replaces a corrupt file with defaults plus the patch', async () => {
    writeFileSync(file, 'garbage')
    await writeSettings(file, {})
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(DEFAULT_SETTINGS)
  })
})
