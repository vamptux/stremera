# Stremera

Stremera is a Tauri desktop app with a Rust backend and React frontend.

## Development

- `bun install`
- `cargo tauri dev`

## Release Builds

- `bun run tauri:clean`
- `bun run tauri:build`
- `bun run tauri:build:unsigned`
- `bun run tauri:build:clean`

Windows releases are packaged as NSIS `.exe` installers. Updater artifacts are generated during release builds so in-app updates can pull signed releases from GitHub Releases.

## Auto Updater

The app uses the Tauri updater plugin with Rust backend commands for update checks and installation, while React only owns the updater UI state and prompts. Each signed GitHub release publishes the static `latest.json` manifest consumed by the desktop app.

Required GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Local signed builds can also use:

- `TAURI_SIGNING_PRIVATE_KEY_PATH`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

The release workflow publishes signed updater artifacts and the Windows installer from tags like `v0.3.1`.

`bun run tauri:build` loads the encrypted key file from `TAURI_SIGNING_PRIVATE_KEY_PATH` into the env var Tauri expects before invoking the build. Use `bun run tauri:build:unsigned` only when you intentionally want a local installer without updater artifacts.

Recommended local verification commands:

- `bun run lint`
- `bun run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `bun run tauri:build`

## Repo Hygiene

- `src-tauri/target` is ignored and can be cleared with the cleanup script before release builds.
- NSIS updates replace the installed app in place; update payloads are downloaded to temporary storage and are not intended to accumulate as extra installed copies.
