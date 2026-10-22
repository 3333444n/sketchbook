// Empty-canvas welcome screen, modelled on excalidraw.com's AppWelcomeScreen.

import { memo } from 'react'
import { WelcomeScreen } from '@excalidraw/excalidraw'
import { shortcut } from '../shortcuts'
import { EXCALIDRAW_GITHUB_URL } from './AppMainMenu'
import { NewWindowIcon, OpenIcon, SketchbookMark } from './icons'

export const AppWelcomeScreen = memo(function AppWelcomeScreen(): React.JSX.Element {
  const sketchbook = window.sketchbook
  return (
    <WelcomeScreen>
      <WelcomeScreen.Hints.MenuHint />
      <WelcomeScreen.Hints.ToolbarHint />
      <WelcomeScreen.Hints.HelpHint />
      <WelcomeScreen.Center>
        <WelcomeScreen.Center.Logo>
          <div className="sketchbook-wordmark">
            {SketchbookMark}
            <span>Sketchbook</span>
          </div>
        </WelcomeScreen.Center.Logo>
        <WelcomeScreen.Center.Heading>
          Your drawings are saved as files on your computer.
          <br />
          Works offline.
        </WelcomeScreen.Center.Heading>
        <WelcomeScreen.Center.Menu>
          <WelcomeScreen.Center.MenuItem
            icon={OpenIcon}
            shortcut={shortcut('CtrlOrCmd+O')}
            onSelect={sketchbook.open}
          >
            Open…
          </WelcomeScreen.Center.MenuItem>
          <WelcomeScreen.Center.MenuItem
            icon={NewWindowIcon}
            shortcut={shortcut('CtrlOrCmd+N')}
            onSelect={sketchbook.newWindow}
          >
            New window
          </WelcomeScreen.Center.MenuItem>
          <WelcomeScreen.Center.MenuItemHelp />
        </WelcomeScreen.Center.Menu>
        <button
          type="button"
          className="sketchbook-credit"
          onClick={() => sketchbook.openExternal(EXCALIDRAW_GITHUB_URL)}
        >
          Built with Excalidraw
        </button>
      </WelcomeScreen.Center>
    </WelcomeScreen>
  )
})
