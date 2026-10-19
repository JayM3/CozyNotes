# Contributing to CozyNotes

Follow the setup instructions in [README.md](README.md), then create a branch for a focused change. Use `npm ci` to install the locked dependencies. Commit `package-lock.json` and `src-tauri/Cargo.lock` whenever dependencies change.

Windows x64 is the supported development, testing, and release target. macOS and Linux support is on hold as of October 19, 2026; compatibility work and release packages for those platforms are deferred.

## Making changes

Use the existing React/TypeScript and Rust conventions. Keep note content local, preserve the native capability boundaries, and describe visible behavior changes in the pull request.

For database changes, preserve existing note documents and metadata, provide a migration, and test against a temporary database. Use `COZYNOTES_TEST_DATA_DIR` in debug desktop runs to isolate test notes from your normal library. Never commit personal note data.

## Validation

Before opening a pull request, run:

```sh
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --debug --no-bundle
```

Add regression coverage when changing storage, search, editor actions, or save coordination. For interface and lifecycle changes, also run `npm run tauri dev` on Windows and exercise creating, editing, closing, reopening, trashing, and restoring notes. Include your Windows version and any checks you could not run in the pull request. Check keyboard access and focus when changing controls.

The CI workflow runs automated tests, Rust formatting, and a debug native build on Windows x64. The release workflow runs on version tags and publishes the Windows standalone executable, NSIS installer, signed Tauri updater, checksums, and a manifest containing only the Windows x64 updater after validation and the Windows build succeed. The repository must have `TAURI_SIGNING_PRIVATE_KEY` configured as a GitHub Actions secret, with `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when the key is password-protected. Automated builds do not replace native interaction or installer testing; Windows publisher signing is not configured.

## Reports and pull requests

Bug reports should include the app version, Windows version, reproduction steps, expected behavior, and actual behavior. Remove personal note text, local paths, and credentials from logs or screenshots before attaching them. Use the feature request template to explain a problem and the behavior you would like.

Keep generated output, executables, databases, local environment files, and signing keys out of commits. Put release binaries in GitHub Releases. Code contributions are provided under the project's [MIT License](LICENSE); third-party material must retain its license and attribution.
