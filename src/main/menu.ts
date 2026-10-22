// Track A: native application menu.
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { is } from '@electron-toolkit/utils'
import { newTab, newUntitledWindow, sendMenuToFocused, showOpenDialog } from './documents'

/**
 * Electron gives each menu item a single accelerator, so alternates are hidden
 * duplicates that still fire.
 */
function hiddenAlias(accelerator: string, click: () => void): MenuItemConstructorOptions {
  return {
    label: accelerator,
    accelerator,
    visible: false,
    acceleratorWorksWhenHidden: true,
    click
  }
}

export function buildMenu(): void {
  app.setAboutPanelOptions({
    applicationName: 'Sketchbook',
    applicationVersion: app.getVersion(),
    credits: 'Built with Excalidraw (MIT License) — https://github.com/excalidraw/excalidraw'
  })

  const nextTab = (): void => sendMenuToFocused('next-tab')
  const prevTab = (): void => sendMenuToFocused('prev-tab')

  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => newTab() },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => newUntitledWindow() },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => void showOpenDialog() },
        {
          label: 'Open Recent',
          role: 'recentDocuments',
          submenu: [{ label: 'Clear Menu', role: 'clearRecentDocuments' }]
        },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendMenuToFocused('save') },
        {
          label: 'Save As…',
          accelerator: 'Shift+CmdOrCtrl+S',
          click: () => sendMenuToFocused('save-as')
        },
        {
          label: 'Export Image…',
          accelerator: 'Shift+CmdOrCtrl+E',
          click: () => sendMenuToFocused('export-image')
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendMenuToFocused('close-tab')
        },
        {
          label: 'Close Window',
          accelerator: 'Shift+CmdOrCtrl+W',
          // close() (not destroy) so the unsaved-changes flow runs.
          click: () => BrowserWindow.getFocusedWindow()?.close()
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        // These dispatch to the focused webContents; Excalidraw handles its own
        // undo/redo keyboard shortcuts inside the canvas.
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Insert',
      submenu: [{ label: 'Mermaid Diagram…', click: () => sendMenuToFocused('mermaid') }]
    },
    {
      label: 'View',
      submenu: [
        ...(is.dev
          ? ([{ role: 'reload' }, { role: 'forceReload' }] as MenuItemConstructorOptions[])
          : []),
        { role: 'toggleDevTools', accelerator: 'Alt+CmdOrCtrl+I' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      // role 'window' keeps macOS's automatic list of open windows.
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Show Next Tab', accelerator: 'Ctrl+Tab', click: nextTab },
        { label: 'Show Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: prevTab },
        hiddenAlias('Shift+CmdOrCtrl+]', nextTab),
        hiddenAlias('Shift+CmdOrCtrl+[', prevTab),
        { type: 'separator' },
        { role: 'front' }
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Excalidraw on GitHub',
          click: () => void shell.openExternal('https://github.com/excalidraw/excalidraw')
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
