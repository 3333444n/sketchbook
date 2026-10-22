// Hamburger menu, modelled on excalidraw.com's AppMainMenu minus collaboration,
// Excalidraw+, socials and sign-up. File items go through main (native dialogs).

import { memo } from 'react'
import { MainMenu } from '@excalidraw/excalidraw'
import type { ThemePreference } from '../theme'
import { shortcut } from '../shortcuts'
import { GitHubIcon, OpenIcon, SaveAsIcon, SaveIcon } from './icons'

export const EXCALIDRAW_GITHUB_URL = 'https://github.com/excalidraw/excalidraw'

type Props = {
  onSave: () => void
  onSaveAs: () => void
  theme: ThemePreference
  onThemeChange: (theme: ThemePreference) => void
}

export const AppMainMenu = memo(function AppMainMenu({
  onSave,
  onSaveAs,
  theme,
  onThemeChange
}: Props): React.JSX.Element {
  const sketchbook = window.sketchbook
  return (
    <MainMenu>
      <MainMenu.Item icon={OpenIcon} shortcut={shortcut('CtrlOrCmd+O')} onSelect={sketchbook.open}>
        Open…
      </MainMenu.Item>
      <MainMenu.Item icon={SaveIcon} shortcut={shortcut('CtrlOrCmd+S')} onSelect={onSave}>
        Save
      </MainMenu.Item>
      <MainMenu.Item icon={SaveAsIcon} shortcut={shortcut('CtrlOrCmd+Shift+S')} onSelect={onSaveAs}>
        Save as…
      </MainMenu.Item>
      <MainMenu.DefaultItems.SaveAsImage />
      <MainMenu.DefaultItems.CommandPalette className="highlighted" />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      <MainMenu.Separator />
      <MainMenu.Item icon={GitHubIcon} onSelect={() => sketchbook.openExternal(EXCALIDRAW_GITHUB_URL)}>
        Excalidraw on GitHub
      </MainMenu.Item>
      <MainMenu.Separator />
      <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={theme} onSelect={onThemeChange} />
      <MainMenu.DefaultItems.ChangeCanvasBackground />
    </MainMenu>
  )
})
