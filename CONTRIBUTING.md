# Contributing

## Requirements

- Bun 1.3 or newer

## Local checks

```bash
bun test
bun run check
bun run compile        # build a binary for the current platform
./dist/manza --version
```

## Cross-compiling release binaries

`bun run build` produces a binary for every supported target: darwin-arm64, darwin-x64, linux-x64, linux-arm64. The script also writes `dist/SHA256SUMS`. To build a single target, pass it as an argument:

```bash
scripts/build linux-arm64
```

## Development notes

- Keep command mappings aligned with the public OpenAPI contract.
- Add or update tests when adding API endpoints or changing request behavior.
- Don't bump `version` by hand: `bin/release` writes it to `package.json`, and `bin/manza.ts` reads it from there.
- Keep API keys out of command arguments, fixtures, logs, and screenshots.
- The CI's staging smoke test runs against the Manza staging API on every PR. A red smoke test means the CLI's request/response contract has drifted from the live API — fix the CLI, not the test, unless the API itself changed intentionally.
