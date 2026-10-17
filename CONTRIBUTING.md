# Contributing to CozyNotes

Follow the setup instructions in [README.md](README.md), then create a branch for a focused change. Use `npm ci` to install the locked dependencies. Commit `package-lock.json` and `src-tauri/Cargo.lock` whenever dependencies change.

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

Add regression coverage when changing storage, search, editor actions, or save coordination. For interface and lifecycle changes, also run `npm run tauri dev` and exercise creating, editing, closing, reopening, trashing, and restoring notes. Include your operating system and any platforms you could not test in the pull request. Check keyboard access and focus when changing controls.

The CI workflow runs automated tests, Rust formatting, and a debug native build on Windows, macOS, and Linux. The release workflow runs on version tags and builds native packages for Windows x64, macOS Apple Silicon and Intel, and Linux x64. It publishes only after every platform succeeds. Automated builds do not replace native interaction or installer testing; publisher signing and macOS notarization are not configured.

## Reports and pull requests

Bug reports should include the app version, operating system, reproduction steps, expected behavior, and actual behavior. Remove personal note text, local paths, and credentials from logs or screenshots before attaching them. Use the feature request template to explain a problem and the behavior you would like.

Keep generated output, executables, databases, local environment files, and signing keys out of commits. Put release binaries in GitHub Releases. Code contributions are provided under the project's [MIT License](LICENSE); third-party material must retain its license and attribution.
