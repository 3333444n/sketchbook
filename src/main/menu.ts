// Track A: native application menu.
import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { is } from '@electron-toolkit/utils'
import { newUntitledWindow, sendMenuToFocused, showOpenDialog } from './documents'

export function buildMenu(): void {
  app.setAboutPanelOptions({
    applicationName: 'Sketchbook',
    applicationVersion: app.getVersion(),
    credits: 'Built with Excalidraw (MIT License) — https://github.com/excalidraw/excalidraw'
  })

  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => newUntitledWindow() },
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
        { role: 'close' }
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
    { role: 'windowMenu' },
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
