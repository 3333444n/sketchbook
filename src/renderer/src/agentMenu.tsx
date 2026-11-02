// Window-level agent-bridge state for the in-app main menu.
//
// Main owns the setting; this mirrors it: the initial value comes from
// `getAgentEnabled`, every later change (native menu, any window's in-app menu,
// a failed start) arrives via `onAgentEnabledChanged`. The value reaches the
// menu through a context rather than editor props so that a toggle re-renders
// the menus only, not the mounted Excalidraw trees.

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { bridge } from './bridge'

export type AgentMenuState = {
  /** The effective state as last reported by main. */
  enabled: boolean
  /** Ask main to flip the bridge; the new state arrives via the subscription. */
  toggle: () => void
  /** Show main's native "Set Up Agent Access" dialog. */
  setup: () => void
}

const NOOP: AgentMenuState = { enabled: false, toggle: () => {}, setup: () => {} }

export const AgentMenuContext = createContext<AgentMenuState>(NOOP)

/** Load the bridge state once, follow main's pushes, and expose stable actions. */
export function useAgentMenu(): AgentMenuState {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let cancelled = false
    bridge.getAgentEnabled().then(
      (on) => {
        if (!cancelled) setEnabled(on)
      },
      (err) => console.error('getAgentEnabled failed', err)
    )
    const off = bridge.onAgentEnabledChanged(setEnabled)
    return () => {
      cancelled = true
      off()
    }
  }, [])
  return useMemo<AgentMenuState>(
    () => ({
      enabled,
      toggle: () => {
        // Main answers with the effective state and also broadcasts it; adopt the
        // answer too so a failed start is reflected even if the push is lost.
        bridge.setAgentEnabled(!enabled).then(setEnabled, (err) => {
          console.error('setAgentEnabled failed', err)
        })
      },
      setup: bridge.showAgentSetup
    }),
    [enabled]
  )
}

export function useAgentMenuContext(): AgentMenuState {
  return useContext(AgentMenuContext)
}
