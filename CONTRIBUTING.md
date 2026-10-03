# Contributing

## Requirements

- Go 1.26 or newer (builds the CLI)
- Bun 1.4.2 or newer (runs the CLI test suite and Biome)

## Local checks

```bash
bun install
bun run check:all      # Biome, go vet, gofmt, go test, then the CLI suite against dist/manza
bun run compile        # build a binary for the current platform
./dist/manza --version
```

`test/cli.test.js` is the CLI's contract: it runs the compiled binary (`MANZA_CLI_BIN`, default `dist/manza`) against a local mock API and checks stdout, stderr, exit codes and the exact requests sent. Add a case there for any behaviour change.

## Cross-compiling release binaries

`scripts/build` produces a binary for every supported target: darwin-arm64, darwin-x64, linux-x64, linux-arm64. The script also writes `dist/SHA256SUMS`. To build a single target, pass it as an argument:

```bash
scripts/build linux-arm64
```

## Development notes

- Keep command mappings aligned with the public OpenAPI contract.
- Add or update tests when adding API endpoints or changing request behavior.
- Don't bump `version` by hand: `bin/release` writes it to `package.json`, and `version.go` embeds it from there.
- Keep API keys out of command arguments, fixtures, logs, and screenshots.
- The CI's staging smoke test runs against the Manza staging API on every PR that has the staging secrets (it is skipped on forks). A red smoke test means the CLI's request/response contract has drifted from the live API — fix the CLI, not the test, unless the API itself changed intentionally.
