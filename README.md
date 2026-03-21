# Streamy

Streamy is a Tauri desktop app with a Rust backend and React frontend.

## Development

- `npm install`
- `cargo tauri dev`

## Release Builds

- `npm run tauri:clean`
- `npm run tauri:build`
- `npm run tauri:build:clean`

Windows releases are packaged as NSIS `.exe` installers. Updater artifacts are generated during release builds so in-app updates can pull signed releases from GitHub Releases.

## Auto Updater

The app uses the Tauri updater plugin and a static `latest.json` manifest published with each GitHub release.

Required GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

The release workflow publishes signed updater artifacts and the Windows installer from tags like `v0.1.0`.

## Repo Hygiene

- `src-tauri/target` is ignored and can be cleared with the cleanup script before release builds.
- NSIS updates replace the installed app in place; update payloads are downloaded to temporary storage and are not intended to accumulate as extra installed copies.
