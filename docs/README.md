# Sketchbook docs

| Doc                                                    | Read it when                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                     | You want the big picture: processes, IPC, and the open/save/close/recovery flows.               |
| [ipc-contract.md](ipc-contract.md)                     | You're adding or changing anything that crosses main ↔ renderer.                                |
| [offline.md](offline.md)                               | You're touching the protocol, CSP, fonts, downloads, or adding a dependency.                    |
| [performance.md](performance.md)                       | You're working on tabs, editor mounting, or anything that runs per change.                      |
| [testing.md](testing.md)                               | You're writing or running tests.                                                                |
| [building-and-releasing.md](building-and-releasing.md) | You're packaging, releasing, or dealing with Gatekeeper.                                        |
| [upgrading-excalidraw.md](upgrading-excalidraw.md)     | You're bumping `@excalidraw/excalidraw` (or React).                                             |
| [roadmap.md](roadmap.md)                               | You want the current status, what isn't verified yet, and ideas for next iterations.            |
| [adr/](adr/README.md)                                  | You want to know _why_ something is the way it is, or you're proposing an architectural change. |

Also see [AGENTS.md](../AGENTS.md) (rules and gotchas) and
[COLLABORATING.md](../COLLABORATING.md) (workflow).
