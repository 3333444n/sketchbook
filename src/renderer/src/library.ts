// Persist the user's shape library across windows and launches.

import { serializeLibraryAsJSON } from '@excalidraw/excalidraw'
import type { LibraryItems } from '@excalidraw/excalidraw/types'
import { readStorage, writeStorage } from './storage'

const LIBRARY_KEY = 'sketchbook:library'

export function loadLibrary(): LibraryItems {
  const raw = readStorage(LIBRARY_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.libraryItems) ? parsed.libraryItems : []
  } catch {
    return []
  }
}

export function saveLibrary(items: LibraryItems): void {
  writeStorage(LIBRARY_KEY, serializeLibraryAsJSON(items))
}
