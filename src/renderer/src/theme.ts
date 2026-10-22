// Theme: follow the system by default, like excalidraw.com's "System" option,
// with a persisted manual override (light / dark / system).

import { useCallback, useEffect, useState } from 'react'
import { THEME } from '@excalidraw/excalidraw'
import type { Theme } from '@excalidraw/excalidraw/element/types'
import { readStorage, writeStorage } from './storage'

export type ThemePreference = Theme | 'system'

const THEME_KEY = 'sketchbook:theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

function readPreference(): ThemePreference {
  const stored = readStorage(THEME_KEY)
  return stored === THEME.LIGHT || stored === THEME.DARK ? stored : 'system'
}

function systemTheme(): Theme {
  return window.matchMedia(DARK_QUERY).matches ? THEME.DARK : THEME.LIGHT
}

export function useTheme(): {
  preference: ThemePreference
  theme: Theme
  setPreference: (pref: ThemePreference) => void
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference)
  const [system, setSystem] = useState<Theme>(systemTheme)

  useEffect(() => {
    const mql = window.matchMedia(DARK_QUERY)
    const onChange = (): void => setSystem(mql.matches ? THEME.DARK : THEME.LIGHT)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref)
    writeStorage(THEME_KEY, pref)
  }, [])

  return { preference, theme: preference === 'system' ? system : preference, setPreference }
}
