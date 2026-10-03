# Manza CLI

Command-line interface for the Manza API.

The CLI defaults to Morocco production at `https://ma.manza.finance`. Use `--base-url` or `MANZA_BASE_URL` only when Manza gives you a different API host.

## Renamed from zazu

Before 1.0 this was the `zazu` CLI (`@getzazu/cli`, `brew install getmanza/tap/zazu`). For all of 1.x:

- `zazu` still works when installed from npm, or when the binary is invoked as `zazu` (e.g. a symlink). It prints a deprecation notice, then runs `manza`.
- An existing login in `~/.config/zazu/config.json` is still read. The first write (`manza login`, `manza config set`, ...) copies it to `~/.config/manza/config.json` and leaves the old file in place. `manza logout` only clears the new file, so delete `~/.config/zazu/config.json` once you no longer run a 0.x `zazu`: it still holds your API key.
- The `ZAZU_API_KEY`, `ZAZU_BASE_URL`, `ZAZU_VERSION` and `ZAZU_TIMEOUT_MS` variables still work, with a deprecation warning. Use the `MANZA_*` names below.
- The Homebrew `zazu` formula is deprecated. Switch with `brew uninstall zazu && brew install getmanza/tap/manza`.

All of these fallbacks are removed in 2.0.

## Install

The CLI ships as a single static Go binary (about 6–7 MB). The Homebrew and direct-download installs need no runtime at all; the npm install needs Node only for the small resolver that launches the binary.

### Homebrew (macOS / Linux)

```bash
brew install getmanza/tap/manza
manza --version
```

### npm

```bash
npm install -g @getmanza/cli
manza --version
```

The npm package is a thin shim that selects the correct platform binary via `optionalDependencies`. If the binary cannot be found after install, `npm install -g @getmanza/cli --include=optional` forces optional deps.

### Direct download

Grab a prebuilt binary from the [latest GitHub Release](https://github.com/getmanza/cli/releases/latest):

```bash
chmod +x manza-darwin-arm64
mv manza-darwin-arm64 /usr/local/bin/manza
manza --version
```

Available targets: `manza-darwin-arm64`, `manza-darwin-x64`, `manza-linux-x64`, `manza-linux-arm64`. Each release publishes a `SHA256SUMS` manifest:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
```

## Run from source

If you have [Go](https://go.dev) 1.26 or newer:

```bash
go run ./cmd/manza --help
```

Or install it onto your path:

```bash
go install github.com/getmanza/cli/cmd/manza@latest
manza --help
```

## Build binaries locally

Build a binary for the current platform:

```bash
bun run compile     # go build -o dist/manza ./cmd/manza
./dist/manza --help
```

Cross-compile binaries for every supported platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64):

```bash
scripts/build
ls dist/   # manza-darwin-arm64, manza-darwin-x64, manza-linux-x64, manza-linux-arm64, SHA256SUMS
```

To build a single target:

```bash
scripts/build linux-arm64
```

## Authentication

The CLI sends `Authorization: Bearer <key>` on every API request. Store the key once using the hidden prompt:

```bash
manza login
```

For scripts and secret managers, pipe the key through stdin so it does not appear in shell history:

```bash
printf '%s\n' "$MANZA_API_KEY" | manza login --api-key-stdin
```

You can also use an environment variable:

```bash
export MANZA_API_KEY="sk_live_..."
```

Optional environment variables:

| Variable | Description |
| --- | --- |
| `MANZA_API_KEY` | API bearer token |
| `MANZA_BASE_URL` | API host, defaults to `https://ma.manza.finance` |
| `MANZA_API_VERSION` | Optional `Manza-Version` header |
| `MANZA_TIMEOUT_MS` | Request timeout in milliseconds, defaults to `30000` |

Global flags:

```text
--api-key <key>       API bearer token
--api-key-stdin       Read API key from stdin for manza login
--base-url <url>      API host, defaults to https://ma.manza.finance
--api-version <date>  Manza-Version header
--timeout-ms <ms>     Request timeout in milliseconds
--output <format>     json, pretty, or raw
--format <format>     Alias for --output
--json                Print compact JSON
--pretty              Print indented JSON
--quiet               Suppress successful response output
--debug               Print request details to stderr
--version             Print CLI version
--help                Show help
```

Config commands:

```bash
printf '%s\n' "$MANZA_API_KEY" | manza login --api-key-stdin
manza logout
manza config get
manza config set api-base <api-host>
manza config set api-version 2026-03-27
manza config unset api-version
```

Production API hosts:

```text
Morocco production      https://ma.manza.finance
South Africa production https://za.manza.finance
```

## Examples

```bash
manza entity get
manza accounts list --currency-code MAD
manza accounts get 01964a3b-0000-7000-8000-ac6000000a01
manza accounts transactions 01964a3b-0000-7000-8000-ac6000000a01 --operation credit
manza accounts transaction 01964a3b-0000-7000-8000-ac6000000a01 01964a3b-7c8d-7000-8000-a10000000001
manza transactions list --account-id 01964a3b-0000-7000-8000-ac6000000a01 --operation credit
manza transactions get --account-id 01964a3b-0000-7000-8000-ac6000000a01 01964a3b-7c8d-7000-8000-a10000000001

manza customers list --q acme
manza customers create \
  --company-name "Acme Corp" \
  --email billing@acme.com \
  --billing-address '{"street":"123 Main St","city":"Casablanca","postal_code":"20000","country":"Morocco","country_code":"MA"}'

manza invoices create --file invoice.json
manza invoices send 01964a3b-7c8d-7000-8000-deadbeef1234
manza invoices payment-link 01964a3b-7c8d-7000-8000-deadbeef1234 --account-id 01964a3b-0000-7000-8000-ac6000000a01

manza payment-links create \
  --account-id 01964a3b-0000-7000-8000-ac6000000a01 \
  --amount 1500.00 \
  --description "March consulting invoice" \
  --payment-reference INV-000042
manza payment-links cancel 01964a3b-7c8d-7000-8000-deadbeef1234

manza webhook-endpoints create \
  --url https://example.com/webhooks/zazu \
  --description "Production" \
  --event payment_link.paid \
  --event transfer.executed
manza webhook-endpoints test 01964a3b-7c8d-7000-8000-deadbeef1234
manza webhook-endpoints regenerate-secret 01964a3b-7c8d-7000-8000-deadbeef1234

manza checkout-sessions create \
  --account-id 01964a3b-0000-7000-8000-ac6000000a01 \
  --amount 100.00 \
  --success-url "https://example.com/ok?session_id={CHECKOUT_SESSION_ID}" \
  --cancel-url https://example.com/cancel \
  --customer-email buyer@example.com
manza checkout-sessions get cs_20OoDQ3U1LlTHdIHh5rEJynM
```

List endpoints use cursor pagination. Fetch one page:

```bash
manza invoices list --limit 25
manza invoices list --limit 25 --cursor eyJpZCI6IjAxOTY0...
manza webhook-endpoints list --limit 25
```

Or let the CLI fetch multiple pages:

```bash
manza invoices list --all
manza invoices list --max-items 100
manza transactions list --account-id 01964a3b-0000-7000-8000-ac6000000a01 --max-items 100
manza webhook-endpoints list --all
```

For nested payloads, use `--data`, `--file`, or `--stdin`:

```bash
manza invoices create --data '{"customer_id":"...","issue_date":"2026-03-15","due_date":"2026-04-15","items":[{"description":"Consulting","quantity":10,"unit_price":"150.00"}]}'
manza invoices create --file invoice.json
cat invoice.json | manza invoices create --stdin
```

## Commands

```text
manza login [--api-key-stdin] [--base-url <url>]
manza logout
manza config get [api-key|api-base|api-version]
manza config set <api-key|api-base|api-version> <value>
manza config unset <api-key|api-base|api-version>

manza entity get
manza status

manza accounts list [--status value] [--currency-code value] [--limit n] [--cursor value] [--all|--max-items n]
manza accounts get <id>
manza accounts transactions <account-id> [--operation value] [--posted-after time] [--posted-before time] [--limit n] [--cursor value] [--all|--max-items n]
manza accounts transaction <account-id> <transaction-id>
manza transactions list --account-id <account-id> [--operation value] [--posted-after time] [--posted-before time] [--limit n] [--cursor value] [--all|--max-items n]
manza transactions get --account-id <account-id> <transaction-id>

manza customers list [--q value] [--limit n] [--cursor value] [--all|--max-items n]
manza customers get <id>
manza customers create [--data json|--file path|--stdin] [customer flags]
manza customers update <id> [--data json|--file path|--stdin] [customer flags]
manza customers delete <id>

manza invoices list [--status value] [--customer-id id] [--limit n] [--cursor value] [--all|--max-items n]
manza invoices get <id>
manza invoices create [--data json|--file path|--stdin] [invoice flags]
manza invoices update <id> [--data json|--file path|--stdin] [invoice flags]
manza invoices send <id>
manza invoices mark-as-paid <id>
manza invoices cancel <id>
manza invoices credit-note <id>
manza invoices delete <id>
manza invoices payment-link <id> --account-id <account-id>

manza payment-links list [--status value] [--link-type value] [--limit n] [--cursor value] [--all|--max-items n]
manza payment-links get <id>
manza payment-links create [--data json|--file path|--stdin] [payment link flags]
manza payment-links cancel <id>

manza webhook-endpoints list [--limit n] [--cursor value] [--all|--max-items n]
manza webhook-endpoints get <id>
manza webhook-endpoints create [--data json|--file path|--stdin] [--url url] [--description text] [--event value]
manza webhook-endpoints update <id> [--data json|--file path|--stdin] [--url url] [--description text] [--event value]
manza webhook-endpoints delete <id>
manza webhook-endpoints test <id>
manza webhook-endpoints regenerate-secret <id>
manza webhook-endpoints enable <id>
manza webhook-endpoints disable <id>

manza checkout-sessions create [--data json|--file path|--stdin] [--account-id id] [--amount amount] [--currency-code value] [--success-url url] [--cancel-url url] [--description text] [--customer-email email] [--metadata json]
manza checkout-sessions get <id>

manza transfers create [--data json|--file path|--stdin] [transfer flags] [--client-reference ref]
manza transfers get <id>
manza transfers authorize <id> --authorization-id <id> --signature <hex>
manza transfers decline <id> --authorization-id <id> [--reason text]
manza transfers sign --secret-env <VAR> --payment-id <id> --nonce <nonce> --amount <decimal> --currency-code <code> --account-id <id> (--external-account-id <id>|--destination-account-id <id>) [--client-reference ref]

manza beneficiaries list [--limit n] [--cursor value] [--all|--max-items n]
manza beneficiaries get <id>
manza beneficiaries create [--data json|--file path|--stdin] [beneficiary flags]
manza beneficiaries accounts list <beneficiary-id> [--limit n] [--cursor value] [--all|--max-items n]
manza beneficiaries accounts get <beneficiary-id> <account-id>
manza beneficiaries accounts create <beneficiary-id> [--data json|--file path|--stdin] [account flags]

manza payee-trust-requests create --external-account-id <id> [--external-account-id <id> ...]
manza payee-trust-requests get <id>

manza request <method> <path> [--data json|--file path|--stdin] [--query key=value]
```

Use `--help` with a resource to show a smaller command reference:

```bash
manza invoices --help
manza webhook-endpoints --help
```

## Release

Releases are tag-driven, cut from a clean, up-to-date `main` with `bin/release` (the manza SDK release kit; repo-specific bits live in `scripts/version` and `scripts/release-check`):

```bash
bin/release list        # last releases + what patch/minor/major would give
bin/release --dry-run   # version + changes since the last tag, publishes nothing
bin/release minor       # or patch (default), major, an explicit 0.3.0; --force re-creates
```

It bumps `package.json`, runs `check:all`, pushes `main` and publishes the GitHub Release (tag `vX.Y.Z`).

The `release.yml` workflow then:
- Verifies the tag matches `package.json` version.
- Runs the test suite + smoke-tests the compiled binary on the host.
- Smoke-tests against the Manza staging API (read-only happy path).
- Cross-compiles all four binaries.
- Creates a GitHub Release with auto-generated notes, binaries, and `SHA256SUMS`.
- Publishes `@getmanza/cli` plus four per-platform packages (`@getmanza/cli-darwin-arm64`, etc.) to npm.
- Bumps the `getmanza/homebrew-tap` formula (gated on `vars.PUBLISH_HOMEBREW == 'true'`).

Pre-release local check:

```bash
bun run check:all   # lint + go test + the CLI suite against dist/manza
scripts/build       # all four targets
ls dist/            # manza-darwin-arm64, manza-darwin-x64, manza-linux-x64, manza-linux-arm64, SHA256SUMS
```

## Keeping the CLI in sync with the API

The CLI wraps the public Manza API endpoint-by-endpoint by hand — there is no codegen yet. When the API adds, removes, or changes an endpoint, the matching change in `cmd/manza/` happens here as a normal PR.

The CI's staging smoke test is the safety net: if the CLI drifts from the API, the next release tag fails on the smoke step before publishing.
