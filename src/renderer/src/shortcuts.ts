// Window-level keyboard handling, all in the capture phase on `window` so it runs
// before Excalidraw's own handlers.
//
// File shortcuts belong to the native menu (main process), which sends them back
// as `onMenu` actions. Stop Excalidraw from also reacting to them: with the file
// system API disabled, its ⇧⌘S handler would trigger a browser download of the
// scene, and ⌘S/⌘O are no-ops at best. We only stop propagation (never
// preventDefault), so Electron still treats the key as unhandled and fires the
// menu accelerator.

import { useEffect, useRef } from 'react'

const MENU_OWNED_KEYS = new Set(['s', 'o', 'n', 't', 'w'])

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent)

const hasCmd = (event: KeyboardEvent): boolean => (isMac ? event.metaKey : event.ctrlKey)

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

/**
 * ⌘1–⌘8 select tab N, ⌘9 the last tab (Chrome/Safari behaviour). Swallowed
 * entirely so Excalidraw never sees them.
 */
export function useTabNumberShortcuts(select: (index: number | 'last') => void): void {
  const selectRef = useRef(select)
  selectRef.current = select
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!hasCmd(event) || event.altKey || event.shiftKey) return
      const match = /^Digit([1-9])$/.exec(event.code) ?? /^([1-9])$/.exec(event.key)
      if (!match) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.repeat) return
      const n = Number(match[1])
      selectRef.current(n === 9 ? 'last' : n - 1)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}

/**
 * Excalidraw (with `handleKeyboardGlobally` off) only hears keys that reach its own
 * container. If focus has fallen back to <body> — e.g. after clicking the tab strip —
 * move it into the active editor and replay the key there, so shortcuts keep
 * working, but only ever for the active tab.
 */
export function useForwardStrayKeys(focusActive: () => HTMLElement | null): void {
  const focusRef = useRef(focusActive)
  focusRef.current = focusActive
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const current = document.activeElement
      if (current && current !== document.body) return
      if (!event.isTrusted) return
      const target = focusRef.current()
      if (!target || target === document.body) return
      event.stopImmediatePropagation()
      target.dispatchEvent(
        new KeyboardEvent(event.type, {
          key: event.key,
          code: event.code,
          location: event.location,
          repeat: event.repeat,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          bubbles: true,
          cancelable: true,
          composed: true
        })
      )
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

/** Format "CtrlOrCmd+Shift+S" the way Excalidraw's own menu items do. */
export function shortcut(keys: string): string {
  return keys.replace(/CtrlOrCmd/g, isMac ? 'Cmd' : 'Ctrl')
}
