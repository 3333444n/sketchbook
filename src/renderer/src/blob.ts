// Turning a DocPayload's raw `contents` into something Excalidraw can restore.

import { loadFromBlob } from '@excalidraw/excalidraw'

export type LoadedScene = Awaited<ReturnType<typeof loadFromBlob>>

/** Decode a `data:<mime>;base64,<payload>` URL into a Blob without using fetch (CSP-safe). */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('Malformed data URL')
  const header = dataUrl.slice(5, comma) // strip "data:"
  const body = dataUrl.slice(comma + 1)
  const isBase64 = /;base64$/i.test(header)
  const mime = header.replace(/;base64$/i, '') || 'application/octet-stream'
  if (!isBase64) return new Blob([decodeURIComponent(body)], { type: mime })
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/** Wrap raw file contents in a Blob with a MIME type `loadFromBlob` understands. */
export function contentsToBlob(contents: string): Blob {
  if (contents.startsWith('data:')) return dataUrlToBlob(contents)
  const head = contents.trimStart().slice(0, 512)
  const looksLikeSvg = head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))
  return new Blob([contents], { type: looksLikeSvg ? 'image/svg+xml' : 'application/json' })
}

/** Parse file contents (.excalidraw JSON, or PNG/SVG with an embedded scene) into a scene. */
export function parseContents(contents: string): Promise<LoadedScene> {
  return loadFromBlob(contentsToBlob(contents), null, null)
}

/** "/Users/me/Plans/Kitchen.excalidraw" -> "Kitchen" */
export function docName(path: string | null): string | undefined {
  if (!path) return undefined
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return (dot > 0 ? base.slice(0, dot) : base) || undefined
}
