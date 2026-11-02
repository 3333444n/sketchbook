// Thin bootstrap. Feature code lives in its own module:
//   protocol.ts  – app:// scheme + renderer loading        (track C)
//   documents.ts – windows, open/save, IPC, recovery, Finder (track A)
//   menu.ts      – native application menu                  (track A)
//   agent.ts     – local agent bridge (Unix socket for the bundled MCP server)
import { app } from 'electron'
import { registerAppScheme, registerAppProtocol } from './protocol'
import { initDocuments } from './documents'
import { initAgent } from './agent'
import { buildMenu } from './menu'

// Must run before `ready`.
registerAppScheme()

// Sets up single-instance lock and `open-file` listeners; must run before `ready`.
initDocuments()

app.whenReady().then(async () => {
  registerAppProtocol()
  // Before the menu so the "Allow Agent Connections" checkbox starts correct.
  await initAgent()
  buildMenu()
})
