# Agent bridge: use Sketchbook with an AI agent

Sketchbook ships an [MCP](https://modelcontextprotocol.io) server that lets a local AI agent
(Claude Code, Claude Desktop, Cursor, Codex or any other MCP client) read and edit the drawing
you are looking at, and look at the result as an image. Everything stays on your Mac: the
agent talks to the app over a local socket, and Sketchbook still makes no network requests.
Decision record: [ADR 0009](adr/0009-agent-bridge-unix-socket-mcp.md).

The bridge requires v1.1.0 or later (the v1.0.0 dmg on GitHub does not include it). Download
the [latest release](https://github.com/3333444n/sketchbook/releases/latest), or
[build from source](building-and-releasing.md) (`pnpm build:mac`).

## User guide

### What it does

With the bridge on, a connected agent can list your open tabs, open a new drawing, read the
elements of a drawing, add shapes, text, arrows and frames, change or delete elements, scroll
your canvas, and render the drawing (or part of it) to a PNG so it can check its own work.

What it cannot do: save, open or export files, read anything outside the open drawings, or
connect while the bridge is off.

### Turn it on

1. Open Sketchbook and turn on **Allow agent connections**, either from the menu bar
   (**Agent ▸ Allow Agent Connections**) or from the in-app hamburger menu (the ☰ button in the
   top-left corner of the canvas). The two always show the same state. The setting is
   remembered across launches and is **off by default**.
2. Choose **Set up agent access…** (**Agent ▸ Set Up Agent Access…** in the menu bar, or the
   item below the checkbox in the hamburger menu). The dialog shows the config for your
   install with two buttons: **Copy claude mcp add command** (Claude Code) and **Copy JSON**
   (everything else).
3. Paste it into your agent's configuration as shown below, then restart or reconnect the
   agent.

Turn it off again with either menu item. Connected agents are cut off immediately and get a
`DISABLED` error on their next call.

### Configure your agent

All clients run the same command: the Sketchbook binary in Node mode, pointed at the bundled
server. The paths below assume Sketchbook is in `/Applications`; the Set Up dialog shows the
right ones for your install.

**Claude Code**

```sh
claude mcp add sketchbook -e ELECTRON_RUN_AS_NODE=1 -- "/Applications/Sketchbook.app/Contents/MacOS/Sketchbook" "/Applications/Sketchbook.app/Contents/Resources/mcp/index.js"
```

Or in a project's `.mcp.json` (add `--scope project` to the command above to write it there):

```json
{
  "mcpServers": {
    "sketchbook": {
      "command": "/Applications/Sketchbook.app/Contents/MacOS/Sketchbook",
      "args": ["/Applications/Sketchbook.app/Contents/Resources/mcp/index.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

**Claude Desktop**: Settings → Developer → Edit Config opens
`~/Library/Application Support/Claude/claude_desktop_config.json`. Add the same `mcpServers`
entry as above and restart Claude Desktop.

**Cursor**: put the same JSON in `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json`
for all projects).

**Codex**: in `~/.codex/config.toml`:

```toml
[mcp_servers.sketchbook]
command = "/Applications/Sketchbook.app/Contents/MacOS/Sketchbook"
args = ["/Applications/Sketchbook.app/Contents/Resources/mcp/index.js"]

[mcp_servers.sketchbook.env]
ELECTRON_RUN_AS_NODE = "1"
```

### Try it

With Sketchbook open and the bridge on, ask your agent things like:

- "Draw the architecture of this repo in Sketchbook: one box per package, arrows for
  dependencies."
- "Look at my current Sketchbook drawing and fix the overlapping boxes."
- "Add a legend in the bottom-right corner of the drawing, then show me the result."
- "Open a new drawing called 'Auth flow' and sketch the login sequence."

### What you will see

- Each agent call that edits the drawing is **one undo step**: ⌘Z takes it back, call by call.
- The tab gets the **unsaved dot** and is autosaved to the recovery journal like any edit.
  Your file on disk only changes when you press ⌘S.
- When the agent targets a tab that is not in front, Sketchbook **switches to that tab** in
  its window (it never brings the window forward). A tab that had been unloaded because more
  than five were open is reloaded first.
- After `add_elements`, the canvas scrolls and zooms to the new elements unless the agent
  asked it not to.
- If no drawing is open, the agent is told to open one with `new_drawing`.

## Tool reference

Eight tools, defined in [`src/mcp/server.ts`](../src/mcp/server.ts). Every per-drawing tool
takes an optional `docId` (from `list_drawings`); when omitted, the target is the active tab
of the focused window (or the last focused one). Results are JSON text, except `get_image`.

| Tool              | Input                                                                                                                                        | Output                                                                                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_drawings`   | none                                                                                                                                         | `{ docs: [{ docId, title, path, dirty, active, windowId }] }`, in window then tab-creation order.                                                                                                                                               |
| `new_drawing`     | `title?` (≤ 200 chars; sanitised like a file name)                                                                                           | The new tab's `{ docId, title, path: null, dirty, active, windowId }`. Opens in the current window, becomes active.                                                                                                                             |
| `get_scene`       | `docId?`, `full?`                                                                                                                            | `{ docId, title, elementCount, bounds, viewBackgroundColor, selectedIds, elements }`; `elements` are compact summaries (id, type, x, y, width, height, text/label, arrow `start`/`end`, colours…) or raw Excalidraw elements with `full: true`. |
| `add_elements`    | `docId?`, `elements[]` (1–2000 skeletons, see cheat sheet), `scrollTo?` (default true)                                                       | `{ ids, bounds }` of the created elements (labels included). One undo step.                                                                                                                                                                     |
| `update_elements` | `docId?`, `elements[]` (1–2000 patches `{ id, …changes }`)                                                                                   | `{ updated, bounds }`. All-or-nothing: any unknown id, unknown key or wrong value rejects the whole call. Bound labels follow their container. One undo step.                                                                                   |
| `delete_elements` | `docId?`, `ids[]` (1–5000)                                                                                                                   | `{ deleted }`. Bound labels go with their shape; arrows bound to a deleted shape are unbound. Unknown ids are ignored. One undo step.                                                                                                           |
| `get_image`       | `docId?`, `ids?`, `maxSize?` (256–4096, default 1200), `background?` (default true), `dark?` (default false), `padding?` (0–500, default 20) | A PNG image, then a text line `W×Hpx, N elements`. Rendered in the app with its bundled fonts.                                                                                                                                                  |
| `scroll_to`       | `docId?`, `ids?`                                                                                                                             | `{ ok: true }`. Scrolls and zooms the user's canvas to the elements (or the whole drawing). No change to the drawing.                                                                                                                           |

Errors come back as `isError` results with the text `CODE: message` (codes below).

### Element cheat sheet

This is what `add_elements` accepts (the same text is in the tool description so the agent
sees it):

- `type`: `rectangle` | `ellipse` | `diamond` | `text` | `arrow` | `line` | `frame` | `image`.
- Position with `x`, `y` (y grows downward) and size with `width`, `height` (default 100×100).
- Shapes and arrows take `label: { text }`, which creates centred, auto-sized bound text.
  `label` may also carry `fontSize`, `strokeColor`, `textAlign`.
- A standalone `text` element uses `text` (newlines allowed), `fontSize` (default 20),
  `fontFamily` 1 (hand-drawn) | 2 (normal) | 3 (code).
- Arrows bind with `start: { id }` and `end: { id }`. An arrow bound at both ends needs no
  `x`/`y`/`points`: it is **routed** between the two shapes, trimmed to their outlines. Unbound
  arrows and lines use `x`, `y` and `points: [[0, 0], [dx, dy], …]`. `endArrowhead: null` makes
  a plain connector, `startArrowhead: "arrow"` a double-headed one. Arrows cannot bind to
  other arrows; lines cannot bind.
- `frame`: `{ type: "frame", name, children: [ids] }` groups elements from the same call or
  already in the drawing; it sizes itself from its children unless given a box.
- `image` needs a `fileId` that already exists in the drawing (agents cannot upload files).
- Colours are hex strings: `strokeColor` (default `#1e1e1e`), `backgroundColor`
  (`transparent` or e.g. `#a5d8ff`); `fillStyle` hachure | solid | cross-hatch; `strokeWidth`
  1 | 2 | 4; `strokeStyle` solid | dashed | dotted; `roughness` 0–2; `opacity` 0–100;
  `roundness: { type: 3 }` for rounded corners.
- Ids are optional; supply short ones (`"db"`, `"api"`) to bind arrows and edit later. They
  must be unique in the drawing. Keys Excalidraw owns (`version`, `index`, `boundElements`,
  `containerId`, bindings…) are stripped.

`update_elements` patches accept geometry (`x`, `y`, `width`, `height`, `angle`), style
(`strokeColor`, `backgroundColor`, `fillStyle`, `strokeWidth`, `strokeStyle`, `roughness`,
`opacity`, `roundness`), `groupIds`, `frameId`, `link`, `locked`, `customData`, and per type:
`text`, `fontSize`, `fontFamily`, `textAlign`, `verticalAlign`, `lineHeight`, `autoResize` on
text (the box is re-measured); `points`, `startArrowhead`, `endArrowhead` on arrows and lines;
`name` on frames; `fileId`, `scale` on images. Read-only keys (`id`, `type`, `version`,
`boundElements`, `containerId`, `startBinding`, `endBinding`…) are ignored; any other key is
rejected. To change an element's type or an arrow's bindings, delete and re-add it.

A bound label follows its container: moving the container moves the label, resizing it
re-wraps the label to the new width, and changing a label's `text` (or the container's size)
re-centres it per its `textAlign` / `verticalAlign`. The patch targets the container or the
label by its own id; there is no need to update both.

## Developer reference

### Architecture

```
MCP client (Claude Code, Claude Desktop, Cursor, Codex)
   │ stdio (MCP, JSON-RPC)
   ▼
MCP server process   ELECTRON_RUN_AS_NODE=1 Sketchbook.app/Contents/MacOS/Sketchbook  Contents/Resources/mcp/index.js
   src/mcp/index.ts → server.ts (8 tools, zod schemas) → client.ts (pointer file, one connection per call)
   │ Unix socket  userData/agent/agent.sock   NDJSON {id, method, params} ⇄ {id, result | error}
   ▼
Main      agentServer.ts (net.Server, framing, validation; no electron import)
          agent.ts (settings, start/stop, setup dialog, on/off notifications)  ·  agentConfig.ts (config snippets)
          menu.ts: native Agent menu  ·  renderer AppMainMenu.tsx: the same two items in the hamburger menu
          (both call agent.ts' setAgentEnabled; it broadcasts `agent:enabled-changed` to every window)
          documents.ts: listTabs / newDrawing answered from the registry; per-doc ops → rendererRequest()
   │ IPC  agent:request {requestId, docId, op, params}  ⇄  agent:response {requestId, ok, result | error}
   ▼
Renderer  App.tsx: activate(docId) → waitForEditor → per-doc queue → agentOps[op]
          agentOps.ts (Excalidraw API)  ·  agentScene.ts (pure validation and planning)
   ▼
ExcalidrawImperativeAPI.updateScene({ captureUpdate: IMMEDIATELY }) → onChange → dirty → autosave
```

The three sides share only the types in [`src/shared/agent.ts`](../src/shared/agent.ts).
The IPC half is in [ipc-contract.md](ipc-contract.md); the flow with the other document flows
is in [architecture.md](architecture.md#agent-edit).

### Socket protocol

- **Transport:** Unix domain socket, NDJSON (one JSON object per line, UTF-8, `\n`
  terminated; a trailing `\r` is tolerated). Several requests may be in flight on one
  connection; responses carry the request's `id`. The bundled client uses one connection per
  call with `id: 1`.
- **Request:** `{ "id": number | string, "method": string, "params"?: object }`. Missing
  `params` means `{}`. Unknown keys in `params` are ignored by main (the renderer rejects
  unknown keys inside element patches).
- **Response:** `{ "id", "result" }` or `{ "id", "error": { "code", "message" } }`. `id` is
  `null` when the line could not be parsed.
- **Methods:** `listTabs`, `newDrawing`, `getScene`, `addElements`, `updateElements`,
  `deleteElements`, `exportImage`, `scrollTo`. Parameters and results are the
  `AgentMethods` type in `src/shared/agent.ts`; the MCP tools map onto them one to one
  (`get_image` → `exportImage`, `list_drawings` → `listTabs`, and so on).

| Error code       | Meaning                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `DISABLED`       | Client side: the setting is off (or absent) and no bridge is advertised.                               |
| `NOT_RUNNING`    | Client side: the setting is on but there is no live pointer, the pid is dead, or the socket refuses.   |
| `NO_SUCH_DOC`    | No open drawing with that `docId`, or no drawing at all when `docId` was omitted.                      |
| `NOT_READY`      | The window is still loading, or the editor did not become ready within 10 s.                           |
| `BAD_PARAMS`     | Validation failed in main or in the renderer; the message says which field.                            |
| `UNKNOWN_METHOD` | Method not in the list above.                                                                          |
| `TIMEOUT`        | The renderer did not answer in 15 s (45 s for `exportImage`); client side, connect or reply timed out. |
| `TOO_LARGE`      | A line exceeded 16 MiB. Main answers with `id: null` and closes the connection.                        |
| `INTERNAL`       | Anything else thrown; main logs it.                                                                    |

**Limits** (literals repeated in `src/main/agentServer.ts`, `src/renderer/src/agentScene.ts`
and `src/mcp/server.ts`): frame ≤ 16 MiB; ≤ 2000 elements per `addElements` /
`updateElements`; ≤ 5000 ids per `deleteElements`; `maxSize` 256–4096 (default 1200);
`padding` 0–1000 on the socket, 0–500 in the MCP tool (default 20); `title` ≤ 200 chars;
`docId` and element ids `^[A-Za-z0-9_-]{1,128}$`; `addElements` types rectangle | ellipse |
diamond | text | arrow | line | frame | image.

**Files** in `userData/agent/` (`~/Library/Application Support/Sketchbook/agent/` for the
packaged app):

| File         | Mode   | Contents                                                                                                                                                                                 |
| ------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (directory)  | `0700` | Created on start.                                                                                                                                                                        |
| `agent.sock` | `0600` | The listening socket. Removed on stop and quit; a leftover from a crash is probed and replaced on the next start.                                                                        |
| `agent.json` | `0644` | Pointer: `{ "protocol": 1, "socketPath", "version", "pid" }` (the `0700` directory keeps it private). Written atomically after listening starts; removed on stop. Clients check the pid. |

When `<userData>/agent/agent.sock` is longer than 100 bytes (macOS caps `sun_path` at 104),
the socket is created as `<tmpdir>/sketchbook-<12 hex of sha256(dir)>.sock` instead; the
pointer file still lives in `userData/agent/` and says where.

### Security model

- **Opt-in.** Nothing listens until the user turns the bridge on; the setting is per profile
  in `userData/settings.json`.
- **Same-user trust.** Directory `0700`, socket `0600`: only processes running as the same
  user can connect. That is the agent's existing level of access (it can already read and
  write the user's files). There is no token or per-client approval.
- **No paths over the socket.** Agents name drawings by `docId` and send element JSON. They
  cannot open, save, export or name a file; `newDrawing`'s title is passed through
  `sanitizeFileName` like a tab rename.
- **Validated in main like IPC.** Every line is parsed and every parameter type-checked and
  bounded in `agentServer.ts` before dispatch. The renderer validates element shapes again
  (`agentScene.ts`) and rejects rather than half-applying.
- **The renderer never writes.** It applies scene edits and reports dirty / autosave as usual;
  disk stays main's job.
- **Not a network feature.** A Unix domain socket is local IPC, like a pipe. It is not
  reachable from the network, the CSP and the `webRequest` block are unchanged, and the offline
  e2e spec still records zero non-local requests. See [offline.md](offline.md).
- The window that receives an `agent:request` is the only one allowed to answer it; main
  matches `requestId` and window id and rejects pending requests when a window closes or its
  renderer dies.

### Development workflow

```bash
pnpm exec electron-vite build        # emits out/main/index.js and out/main/mcp.js
pnpm mcp                             # runs the MCP server on stdio (node out/main/mcp.js)
```

Register the dev build with Claude Code (the dev app must be running with the bridge on):

```bash
claude mcp add sketchbook-dev -e ELECTRON_RUN_AS_NODE=1 -- node $PWD/out/main/mcp.js
```

`ELECTRON_RUN_AS_NODE=1` is harmless for plain `node` and matches what the packaged command
does. In `pnpm dev`, **Agent ▸ Set Up Agent Access…** shows the Electron binary plus
`out/main/mcp.js` instead of the packaged paths.

- The dev app's `userData` is `~/Library/Application Support/sketchbook` (lowercase; Electron
  takes the name from `package.json`), the packaged app's is `…/Sketchbook`. The client tries
  `Sketchbook` first, then `sketchbook`. If both exist (a packaged install plus a dev build),
  set `SKETCHBOOK_USER_DATA` in the MCP client's `env` to the one you mean.
- `SKETCHBOOK_USER_DATA=<dir>` also targets an isolated profile, for example an app started
  with `--user-data-dir=<dir>` in e2e tests.
- A quick check without an MCP client: with the app running and the bridge on,
  `printf '{"id":1,"method":"listTabs"}\n' | nc -U "$(jq -r .socketPath ~/Library/Application\ Support/sketchbook/agent/agent.json)"`.
- Never `console.log` in `src/mcp/`: stdout is the MCP transport. Use `console.error`.
- `src/mcp/` must not import `electron` or any runtime module from `src/main`; the
  `mcpSelfContained` plugin in `electron.vite.config.ts` fails the build if `mcp.js` ends up
  with imports other than Node built-ins.

### Troubleshooting

| Symptom                                               | Cause and fix                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool call returns `DISABLED: …`                       | The setting is off or the settings file is absent in the profile the client looks at, whether or not the app is running. Turn on **Allow agent connections** (menu bar or hamburger menu), or set `SKETCHBOOK_USER_DATA` if the client reads another profile. |
| `NOT_RUNNING: Sketchbook isn't running…`              | The setting is on but the app is not running, or the pointer belongs to a dead process (the message says "stale"). Start Sketchbook; a stale pointer is replaced when the bridge starts.                                                                      |
| `NOT_RUNNING` with the app running                    | The setting is on in the profile the client reads, but that profile's app is not running (dev vs packaged, or an isolated `--user-data-dir`). Set `SKETCHBOOK_USER_DATA` to the running app's profile.                                                        |
| Stale socket, "another instance is already listening" | A second Sketchbook (for example a dev build with the same profile) owns the socket. Quit it, or toggle the menu item off and on; `agent.sock` and `agent.json` are safe to delete when the app is closed.                                                    |
| `NOT_READY`                                           | The tab was still loading (a remount after eviction, or a window still starting). Retry.                                                                                                                                                                      |
| `tools/list` works but every call fails               | Expected with the app closed: the server starts without the app so clients can list tools.                                                                                                                                                                    |
| Claude Desktop shows the server as failed             | Check `~/Library/Logs/Claude/mcp*.log` (`mcp-server-sketchbook.log` for this server). Usually a wrong path or a missing `ELECTRON_RUN_AS_NODE` (the app opens a window instead of serving stdio).                                                             |
| The app launched a window when the client started it  | `ELECTRON_RUN_AS_NODE=1` is missing from the client's `env`.                                                                                                                                                                                                  |
| Agent edits are not undoable in one step              | They should be; each call is one `captureUpdate: IMMEDIATELY`. Report it with the call that misbehaved.                                                                                                                                                       |

Main logs bridge problems to its stderr with an `[agent]` prefix (visible when the app is run
from a terminal: `/Applications/Sketchbook.app/Contents/MacOS/Sketchbook`).
