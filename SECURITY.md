# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems.

Report privately through GitHub Security Advisories:
<https://github.com/3333444n/sketchbook/security/advisories/new>
(repository → Security → Report a vulnerability).

Include what you found, steps or a proof of concept, the affected version, and the impact you
expect. You'll get an acknowledgement as soon as the maintainer sees it; this is a
volunteer-run project, so please allow reasonable time for a fix before disclosing publicly.

## Supported versions

Only the latest release receives fixes.

## Scope

In scope, for example:

- Escaping the renderer sandbox or reaching Node APIs from page content
- Making main write to a path the user didn't choose
- Bypassing the CSP or the network block (any outbound request the user didn't initiate)
- Navigation or `shell.openExternal` abuse from a crafted `.excalidraw`, PNG or SVG file
- Path traversal in the `app://` protocol handler or recovery journal

Out of scope:

- Vulnerabilities in Excalidraw itself that also affect excalidraw.com. Report those to
  [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw/security).
- Gatekeeper warnings about the ad-hoc-signed build (expected; see
  [docs/building-and-releasing.md](docs/building-and-releasing.md)).
- Issues that need an attacker who already has local code execution as the user.

## Design

The security model (context isolation, sandbox, narrow preload API, sender validation, path
ownership in main, blocked navigation, offline enforcement) is described in
[docs/architecture.md](docs/architecture.md#security-boundaries) and
[docs/offline.md](docs/offline.md).
