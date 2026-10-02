# Zazu CLI

Command-line interface for the Zazu API.

The CLI defaults to Morocco production at `https://zazu.ma`. Use `--base-url` or `ZAZU_BASE_URL` only when Zazu gives you a different API host.

## Install

The CLI ships as a single self-contained binary that bundles the Bun runtime — no Bun, Node, or Ruby required on the user's machine.

### Homebrew (macOS / Linux)

```bash
brew install getzazu/tap/zazu
zazu --version
```

### npm

```bash
npm install -g @getzazu/cli
zazu --version
```

The npm package is a thin shim that selects the correct platform binary via `optionalDependencies`. If the binary cannot be found after install, `npm install -g @getzazu/cli --include=optional` forces optional deps.

### Direct download

Grab a prebuilt binary from the [latest GitHub Release](https://github.com/getzazu/cli/releases/latest):

```bash
chmod +x zazu-darwin-arm64
mv zazu-darwin-arm64 /usr/local/bin/zazu
zazu --version
```

Available targets: `zazu-darwin-arm64`, `zazu-darwin-x64`, `zazu-linux-x64`, `zazu-linux-arm64`. Each release publishes a `SHA256SUMS` manifest:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
```

## Run from source

If you have [Bun](https://bun.sh) 1.3 or newer:

```bash
bun ./bin/zazu.js --help
```

Or via the package script:

```bash
bun run start -- accounts list
```

Or link it onto your path:

```bash
bun link
zazu --help
```

## Build binaries locally

Build a binary for the current platform:

```bash
bun run compile
./dist/zazu --help
```

Cross-compile binaries for every supported platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64):

```bash
bun run build
ls dist/   # zazu-darwin-arm64, zazu-darwin-x64, zazu-linux-x64, zazu-linux-arm64, SHA256SUMS
```

To build a single target:

```bash
scripts/build linux-arm64
```

## Authentication

The CLI sends `Authorization: Bearer <key>` on every API request. Store the key once using the hidden prompt:

```bash
zazu login
```

For scripts and secret managers, pipe the key through stdin so it does not appear in shell history:

```bash
printf '%s\n' "$ZAZU_API_KEY" | zazu login --api-key-stdin
```

You can also use an environment variable:

```bash
export ZAZU_API_KEY="sk_live_..."
```

Optional environment variables:

| Variable | Description |
| --- | --- |
| `ZAZU_API_KEY` | API bearer token |
| `ZAZU_BASE_URL` | API host, defaults to `https://zazu.ma` |
| `ZAZU_VERSION` | Optional `Zazu-Version` header |
| `ZAZU_TIMEOUT_MS` | Request timeout in milliseconds, defaults to `30000` |

Global flags:

```text
--api-key <key>       API bearer token
--api-key-stdin       Read API key from stdin for zazu login
--base-url <url>      API host, defaults to https://zazu.ma
--api-version <date>  Zazu-Version header
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
printf '%s\n' "$ZAZU_API_KEY" | zazu login --api-key-stdin
zazu logout
zazu config get
zazu config set api-base <api-host>
zazu config set api-version 2026-03-27
zazu config unset api-version
```

Production API hosts:

```text
Morocco production      https://zazu.ma
South Africa production https://zazu.africa
```

## Examples

```bash
zazu entity get
zazu accounts list --currency-code MAD
zazu accounts get 01964a3b-0000-7000-8000-ac6000000a01
zazu accounts transactions 01964a3b-0000-7000-8000-ac6000000a01 --operation credit
zazu accounts transaction 01964a3b-0000-7000-8000-ac6000000a01 01964a3b-7c8d-7000-8000-a10000000001
zazu transactions list --account-id 01964a3b-0000-7000-8000-ac6000000a01 --operation credit
zazu transactions get --account-id 01964a3b-0000-7000-8000-ac6000000a01 01964a3b-7c8d-7000-8000-a10000000001

zazu customers list --q acme
zazu customers create \
  --company-name "Acme Corp" \
  --email billing@acme.com \
  --billing-address '{"street":"123 Main St","city":"Casablanca","postal_code":"20000","country":"Morocco","country_code":"MA"}'

zazu invoices create --file invoice.json
zazu invoices send 01964a3b-7c8d-7000-8000-deadbeef1234
zazu invoices payment-link 01964a3b-7c8d-7000-8000-deadbeef1234 --account-id 01964a3b-0000-7000-8000-ac6000000a01

zazu payment-links create \
  --account-id 01964a3b-0000-7000-8000-ac6000000a01 \
  --amount 1500.00 \
  --description "March consulting invoice" \
  --payment-reference INV-000042
zazu payment-links cancel 01964a3b-7c8d-7000-8000-deadbeef1234

zazu webhook-endpoints create \
  --url https://example.com/webhooks/zazu \
  --description "Production" \
  --event payment_link.paid \
  --event transfer.executed
zazu webhook-endpoints test 01964a3b-7c8d-7000-8000-deadbeef1234
zazu webhook-endpoints regenerate-secret 01964a3b-7c8d-7000-8000-deadbeef1234

zazu checkout-sessions create \
  --account-id 01964a3b-0000-7000-8000-ac6000000a01 \
  --amount 100.00 \
  --success-url "https://example.com/ok?session_id={CHECKOUT_SESSION_ID}" \
  --cancel-url https://example.com/cancel \
  --customer-email buyer@example.com
zazu checkout-sessions get cs_20OoDQ3U1LlTHdIHh5rEJynM
```

List endpoints use cursor pagination. Fetch one page:

```bash
zazu invoices list --limit 25
zazu invoices list --limit 25 --cursor eyJpZCI6IjAxOTY0...
zazu webhook-endpoints list --limit 25
```

Or let the CLI fetch multiple pages:

```bash
zazu invoices list --all
zazu invoices list --max-items 100
zazu transactions list --account-id 01964a3b-0000-7000-8000-ac6000000a01 --max-items 100
zazu webhook-endpoints list --all
```

For nested payloads, use `--data`, `--file`, or `--stdin`:

```bash
zazu invoices create --data '{"customer_id":"...","issue_date":"2026-03-15","due_date":"2026-04-15","items":[{"description":"Consulting","quantity":10,"unit_price":"150.00"}]}'
zazu invoices create --file invoice.json
cat invoice.json | zazu invoices create --stdin
```

## Commands

```text
zazu login [--api-key-stdin] [--base-url <url>]
zazu logout
zazu config get [api-key|api-base|api-version]
zazu config set <api-key|api-base|api-version> <value>
zazu config unset <api-key|api-base|api-version>

zazu entity get
zazu status

zazu accounts list [--status value] [--currency-code value] [--limit n] [--cursor value] [--all|--max-items n]
zazu accounts get <id>
zazu accounts transactions <account-id> [--operation value] [--posted-after time] [--posted-before time] [--limit n] [--cursor value] [--all|--max-items n]
zazu accounts transaction <account-id> <transaction-id>
zazu transactions list --account-id <account-id> [--operation value] [--posted-after time] [--posted-before time] [--limit n] [--cursor value] [--all|--max-items n]
zazu transactions get --account-id <account-id> <transaction-id>

zazu customers list [--q value] [--limit n] [--cursor value] [--all|--max-items n]
zazu customers get <id>
zazu customers create [--data json|--file path|--stdin] [customer flags]
zazu customers update <id> [--data json|--file path|--stdin] [customer flags]
zazu customers delete <id>

zazu invoices list [--status value] [--customer-id id] [--limit n] [--cursor value] [--all|--max-items n]
zazu invoices get <id>
zazu invoices create [--data json|--file path|--stdin] [invoice flags]
zazu invoices update <id> [--data json|--file path|--stdin] [invoice flags]
zazu invoices send <id>
zazu invoices mark-as-paid <id>
zazu invoices cancel <id>
zazu invoices credit-note <id>
zazu invoices delete <id>
zazu invoices payment-link <id> --account-id <account-id>

zazu payment-links list [--status value] [--link-type value] [--limit n] [--cursor value] [--all|--max-items n]
zazu payment-links get <id>
zazu payment-links create [--data json|--file path|--stdin] [payment link flags]
zazu payment-links cancel <id>

zazu webhook-endpoints list [--limit n] [--cursor value] [--all|--max-items n]
zazu webhook-endpoints get <id>
zazu webhook-endpoints create [--data json|--file path|--stdin] [--url url] [--description text] [--event value]
zazu webhook-endpoints update <id> [--data json|--file path|--stdin] [--url url] [--description text] [--event value]
zazu webhook-endpoints delete <id>
zazu webhook-endpoints test <id>
zazu webhook-endpoints regenerate-secret <id>
zazu webhook-endpoints enable <id>
zazu webhook-endpoints disable <id>

zazu checkout-sessions create [--data json|--file path|--stdin] [--account-id id] [--amount amount] [--currency-code value] [--success-url url] [--cancel-url url] [--description text] [--customer-email email] [--metadata json]
zazu checkout-sessions get <id>

zazu request <method> <path> [--data json|--file path|--stdin] [--query key=value]
```

Use `--help` with a resource to show a smaller command reference:

```bash
zazu invoices --help
zazu webhook-endpoints --help
```

## Release

Releases are tag-driven, cut from a clean, up-to-date `main` with `bin/release` (the zazu SDK release kit; repo-specific bits live in `scripts/version` and `scripts/release-check`):

```bash
bin/release list        # last releases + what patch/minor/major would give
bin/release --dry-run   # version + changes since the last tag, publishes nothing
bin/release minor       # or patch (default), major, an explicit 0.3.0; --force re-creates
```

It bumps `package.json`, runs `check:all`, pushes `main` and publishes the GitHub Release (tag `vX.Y.Z`).

The `release.yml` workflow then:
- Verifies the tag matches `package.json` version.
- Runs the test suite + smoke-tests the compiled binary on the host.
- Smoke-tests against the Zazu staging API (read-only happy path).
- Cross-compiles all four binaries.
- Creates a GitHub Release with auto-generated notes, binaries, and `SHA256SUMS`.
- Publishes `@getzazu/cli` plus four per-platform packages (`@getzazu/cli-darwin-arm64`, etc.) to npm.
- Bumps the `getzazu/homebrew-tap` formula (gated on `vars.PUBLISH_HOMEBREW == 'true'`).

Pre-release local check:

```bash
bun test
bun run check
bun run build       # all four targets
ls dist/            # zazu-darwin-arm64, zazu-darwin-x64, zazu-linux-x64, zazu-linux-arm64, SHA256SUMS
```

## Keeping the CLI in sync with the API

The CLI wraps the public Zazu API endpoint-by-endpoint by hand — there is no codegen yet. When the API adds, removes, or changes an endpoint, the matching change in `bin/zazu.js` happens here as a normal PR.

The CI's staging smoke test is the safety net: if the CLI drifts from the API, the next release tag fails on the smoke step before publishing.
