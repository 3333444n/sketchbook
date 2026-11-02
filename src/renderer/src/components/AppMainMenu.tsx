// Hamburger menu, modelled on excalidraw.com's AppMainMenu minus collaboration,
// Excalidraw+, socials and sign-up. File items go through main (native dialogs).
// The agent section mirrors the native Agent menu; main owns that state.

import { memo } from 'react'
import { MainMenu } from '@excalidraw/excalidraw'
import type { ThemePreference } from '../theme'
import { useAgentMenuContext } from '../agentMenu'
import { bridge } from '../bridge'
import { shortcut } from '../shortcuts'
import {
  GitHubIcon,
  OpenIcon,
  PlugIcon,
  SaveAsIcon,
  SaveIcon,
  SquareCheckIcon,
  SquareIcon
} from './icons'

export const EXCALIDRAW_GITHUB_URL = 'https://github.com/excalidraw/excalidraw'

type Props = {
  onSave: () => void
  onSaveAs: () => void
  theme: ThemePreference
  onThemeChange: (theme: ThemePreference) => void
}

/** "Allow agent connections" (checkbox) and "Set up agent access…". */
function AgentItems(): React.JSX.Element {
  const agent = useAgentMenuContext()
  return (
    <>
      <MainMenu.Item
        icon={agent.enabled ? <SquareCheckIcon /> : <SquareIcon />}
        selected={agent.enabled}
        role="menuitemcheckbox"
        aria-checked={agent.enabled}
        data-testid="agent-toggle"
        onSelect={agent.toggle}
      >
        Allow agent connections
      </MainMenu.Item>
      <MainMenu.Item icon={<PlugIcon />} data-testid="agent-setup" onSelect={agent.setup}>
        Set up agent access…
      </MainMenu.Item>
    </>
  )
}

export const AppMainMenu = memo(function AppMainMenu({
  onSave,
  onSaveAs,
  theme,
  onThemeChange
}: Props): React.JSX.Element {
  return (
    <MainMenu>
      <MainMenu.Item icon={<OpenIcon />} shortcut={shortcut('CtrlOrCmd+O')} onSelect={bridge.open}>
        Open…
      </MainMenu.Item>
      <MainMenu.Item icon={<SaveIcon />} shortcut={shortcut('CtrlOrCmd+S')} onSelect={onSave}>
        Save
      </MainMenu.Item>
      <MainMenu.Item
        icon={<SaveAsIcon />}
        shortcut={shortcut('CtrlOrCmd+Shift+S')}
        onSelect={onSaveAs}
      >
        Save as…
      </MainMenu.Item>
      <MainMenu.DefaultItems.SaveAsImage />
      <MainMenu.DefaultItems.CommandPalette className="highlighted" />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      <MainMenu.Separator />
      <AgentItems />
      <MainMenu.Separator />
      <MainMenu.Item
        icon={<GitHubIcon />}
        onSelect={() => bridge.openExternal(EXCALIDRAW_GITHUB_URL)}
      >
        Excalidraw on GitHub
      </MainMenu.Item>
      <MainMenu.Separator />
      <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={theme} onSelect={onThemeChange} />
      <MainMenu.DefaultItems.ChangeCanvasBackground />
    </MainMenu>
  )
})
