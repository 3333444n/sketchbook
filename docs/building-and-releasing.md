# Building and releasing

## Build

```bash
pnpm build:mac     # typecheck, electron-vite build, electron-builder --mac
```

- Output: an arm64 `.dmg` in `dist/`. Apple Silicon only; Intel and universal builds are not
  produced.
- `pnpm build:unpack` builds an unpacked app (`dist/mac-arm64/`) for quick testing without a dmg.
- Packaging config: [`electron-builder.yml`](../electron-builder.yml). It registers the
  `.excalidraw` file association so Finder opens drawings in Sketchbook.
- The build is **ad-hoc signed** (`identity: "-"`), with hardened runtime and notarization off.
  Ad-hoc signing is required for arm64 binaries to run at all, but it is not a Developer ID
  signature, so Gatekeeper treats the app as from an unidentified developer.

## Release

1. Bump `version` in `package.json`, commit `chore: release vX.Y.Z`.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) builds the dmg on tag pushes
   and uploads it as a workflow artifact. Alternatively build locally with `pnpm build:mac`.
4. Create a GitHub Release for the tag, attach the dmg, and include the Gatekeeper
   instructions below in the notes. The README's download link points at
   `releases/latest`, so the newest release must have the dmg attached. For example:

   ```bash
   gh release create vX.Y.Z dist/Sketchbook-X.Y.Z-arm64.dmg -R 3333444n/sketchbook \
     --title "Sketchbook X.Y.Z" --notes-file notes.md
   ```

CI uses `--publish never`; nothing is uploaded automatically. v1.0.0 (2026-10-22) was released
this way, with the dmg built locally.

## Updates

There is **no auto-update and no update check**. Users install a new version by downloading
the new dmg and dragging Sketchbook to Applications again (Replace). Drawings are separate
files and settings live in `~/Library/Application Support/sketchbook`, so both survive. The
options for adding an update mechanism, and why true auto-update needs Developer ID signing,
are in [roadmap.md](roadmap.md#updates).

## Installing an unsigned build (Gatekeeper)

Users downloading the dmg will see "Sketchbook can't be opened" or "Apple could not verify…".

**macOS 15 (Sequoia) and later**

1. Drag Sketchbook to Applications and try to open it once; dismiss the warning.
2. Open System Settings → Privacy & Security, scroll to Security, click **Open Anyway** next to
   the Sketchbook message, and confirm.

(Control-click → Open no longer bypasses Gatekeeper on macOS 15+.)

**Terminal alternative (any version)**

```bash
xattr -cr /Applications/Sketchbook.app
```

This removes the quarantine attribute that the browser added on download.

## Future: Developer ID signing and notarization

Not set up today. To distribute without the Gatekeeper step:

1. Enrol in the Apple Developer Program and create a **Developer ID Application** certificate.
2. In `electron-builder.yml`: remove the ad-hoc identity, enable `hardenedRuntime: true`, set
   `notarize: true`, and review `build/entitlements.mac.plist` (drop entitlements the app
   doesn't need).
3. In CI, provide the certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`) and notarization
   credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, or an App Store
   Connect API key) as repository secrets.
4. Verify with `spctl -a -vv /Applications/Sketchbook.app` and `xcrun stapler validate`.

This would be an architectural change to the release process; record it in an
[ADR](adr/README.md).
