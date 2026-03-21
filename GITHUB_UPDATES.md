# GitHub Updates

## Next pass

- Keep Tauri packages current together: `@tauri-apps/cli`, `@tauri-apps/api`, Rust `tauri`, `tauri-build`, updater/process plugins.
- Keep frontend tooling current in small batches: Vite, React, TypeScript, ESLint, Tailwind.
- Before version bumps, run `npm run lint`, `npm run build`, `cargo check`, `cargo clippy --all-targets --all-features -- -D warnings`, and one signed `npm run tauri:build`.

## Updater follow-ups

- Test a real in-app upgrade path from one public tag to the next, not just fresh installs.
- Add a short release checklist for `version bump -> commit -> tag -> verify latest.json -> test updater`.
- Consider showing clearer update metadata in Settings: release date, changelog summary, install status, retry action.
- Keep `latest.json` and installer signatures verified after each release.

## Branding

- Replace the temporary app icon/logo set with final branded assets for Tauri icons, installer, GitHub release presentation, and app header usage.
- Rebuild all platform icon sizes from one source asset to keep installer/app branding consistent.

## Cache and install hygiene

- Verify update installs replace the current NSIS app in place and do not leave stale copies under user install locations.
- Keep temporary build output out of git: `dist`, `src-tauri/target`, local cargo cache.
- Add a post-update smoke test for old temp installer cleanup and launch-after-update behavior.
- If app cache growth becomes noticeable, add a targeted cache cleanup command for stale image/query/temp data rather than broad deletion.

## Repo hygiene

- Move large `libmpv` binaries out of normal git history for future work if possible; GitHub accepted them, but they are above the recommended size limit.
- Keep release notes concise and user-facing; keep maintenance notes here instead of expanding README too much.
- Consider GitHub issue templates for release regressions, updater failures, and installer problems.