// File shortcuts belong to the native menu (main process), which sends them back
// as `onMenu` actions. Stop Excalidraw from also reacting to them: with the file
// system API disabled, its ⇧⌘S handler would trigger a browser download of the
// scene, and ⌘S/⌘O are no-ops at best.
//
// We only stop propagation (never preventDefault), so Electron still treats the
// key as unhandled and fires the menu accelerator.

import { useEffect } from 'react'

const MENU_OWNED_KEYS = new Set(['s', 'o', 'n'])

export function useMenuOwnedShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (MENU_OWNED_KEYS.has(event.key.toLowerCase())) event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent)

/** Format "CtrlOrCmd+Shift+S" the way Excalidraw's own menu items do. */
export function shortcut(keys: string): string {
  return keys.replace(/CtrlOrCmd/g, isMac ? 'Cmd' : 'Ctrl')
}
