# Manza CLI

Command-line interface for the Manza API.

The CLI defaults to Morocco production at `https://ma.manza.finance`. Use `--base-url` or `MANZA_BASE_URL` only when Manza gives you a different API host.

## Renamed from zazu

Before 1.0 this was the `zazu` CLI (`@getzazu/cli`, `brew install getmanza/tap/zazu`). 1.x kept the old name working; 2.0 removes it:

- The npm package installs only `manza`; there is no `zazu` command. Run `manza`.
- `~/.config/zazu/config.json` is no longer read. Any 1.x write (`manza login`, `manza config set`, ...) already copied it to `~/.config/manza/config.json`; if you never wrote one, run `manza login` again. Then delete `~/.config/zazu/config.json`: it still holds your API key.
- `ZAZU_API_KEY`, `ZAZU_BASE_URL`, `ZAZU_VERSION`, `ZAZU_API_VERSION` and `ZAZU_TIMEOUT_MS` are no longer read. Without `MANZA_*` values, flags or a saved config, a script that sets only those runs with no API key, the default host and no version pin. Use the `MANZA_*` names below.
- The Homebrew `zazu` formula is frozen at 0.x. Switch with `brew uninstall zazu && brew install getmanza/tap/manza`.

## Upgrading from 1.x

2.0 drops the zazu name (above) and follows the Manza API of 2026-11-13 (manza-go 2.0):

- `manza invoices payment-link` is gone, as is the endpoint behind it. Pass `--account-id <id>` (required on create: the account the invoice is paid into) and `--generate-payment-link true` to `manza invoices create` or `update`; the link is made when the invoice is approved.
- `manza transfers sign` signs v2 (`manza.transfer-authorization.v2|…|<client_reference>|<transfer_method>`). Pass `--transfer-method` as the create response's `transfer_method`, and leave it out when that was null. The API verifies v2 on every authorize call except one pinned to `Manza-Version: 2026-03-27`, which still verifies only v1. If you set that version (`manza config set api-version 2026-03-27`, `MANZA_API_VERSION` or `--api-version`; `manza config get api-version` shows the stored one), `manza transfers authorize` sends it too: unset it (`manza config unset api-version`) or stay on 1.x. Five invalid signatures fail a challenge, and five in a row suspend the authorizer.
- `manza transfers create --transfer-method` picks the rail: `eft` or `rtc` in South Africa, `standard` or `instant` in Morocco.
- A `plan_limit_reached` error (422) adds its `kind`, `current` and `max` next to `status`, the way a duplicate client reference adds `payment_id`.

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
manza config set api-version 2026-11-13
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
manza invoices update 01964a3b-7c8d-7000-8000-deadbeef1234 --account-id 01964a3b-0000-7000-8000-ac6000000a01 --generate-payment-link true

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
manza invoices create --data '{"customer_id":"...","account_id":"...","issue_date":"2026-03-15","due_date":"2026-04-15","items":[{"description":"Consulting","quantity":10,"unit_price":"150.00"}]}'
manza invoices create --file invoice.json
cat invoice.json | manza invoices create --stdin
```

## Debugging transfer authorization

Three questions come up when a machine-authorized transfer does not go the way you expected. `transfer-authorizer get` and `transfers get` print the API's JSON on stdout as usual and put the human summary on stderr, so scripts that parse stdout are unaffected (`--quiet` hides both). `webhooks verify` never calls the API.

**Is my authorizer active?**

```bash
manza transfer-authorizer get
```

```text
Transfer authorizer: active
Limits: 5000.0 MAD per transfer, 20000.0 MAD per 24 hours
New payees: approved up to 1000.0 MAD per transfer
Last 24 hours: 1500.5 MAD authorized, 18499.5 MAD remaining
Secret expires: 2027-01-18T00:00:00Z
Webhook endpoint: 01958e51-7c5a-7000-8000-000000000020
```

The `New payees` line says whether *Approve transfers to new payees* is on, and up to what amount (`not approved (Approve transfers to new payees is off)` otherwise). A suspended authorizer shows its `suspension_reason` (for example `suspended (secret_expired: the signing secret expired)`). The secret's expiry carries a warning within 7 days of it, and says when it has expired. With nothing enrolled the command exits 1 with `No transfer authorizer enrolled: Settings → Developer → Transfer approval`.

**Why did this payment go to the approvers?**

```bash
manza transfers get 0199a1b2-0000-7000-8000-000000000001
```

After the payment's JSON, stderr carries one `Approval:` line: `challenge sent to your authorizer (expires …)`, `authorized`, `declined by your authorizer; the payment is deleted`, or `sent to your approvers: <reason in words> (<refusal_reason>)` (a closed challenge without a reason reads `<status>; sent to your approvers`). A payment created while no authorizer was enrolled has a null `authorization` and says so. The reasons, as in the [API docs](https://ma.manza.finance/docs/api/transfer-authorization):

| `refusal_reason` | What it means | Fix |
|---|---|---|
| `untrusted_payee` | The payee's bank details are not trusted: never trusted with Approve transfers to new payees off, or a member revoked their trust, or they were edited after trusting | `manza payee-trust-requests create` and have an approver accept it; for details never trusted, an approver may instead turn on Approve transfers to new payees |
| `unrestricted_api_key` | The payee is not trusted yet and the API key that created the transfer has no IP allowlist (or one whose networks together allow every address), or was revoked since | Add an IP allowlist to that key in Settings → Developer → API keys |
| `over_new_payee_limit` | The payee is not trusted yet and the amount is above the limit per transfer to a new payee | Pay up to that limit first (its signature trusts the payee), or have an approver raise it |
| `over_transfer_limit` | The amount is above the limit per transfer | Split the payment, or have an approver raise the limit |
| `over_daily_limit` | This amount plus the last 24 hours' authorized total is above the limit per 24 hours | Wait for older authorizations to leave the window, or raise the limit; see `manza transfer-authorizer get` |
| `currency_mismatch` | The source account's currency is not the enrolled currency | Pay from an account in the enrolled currency, or enrol that currency |
| `suspended` | Transfer authorization is suspended, or its endpoint is disabled | Fix the cause `manza transfer-authorizer get` shows; an approver then resumes it in the app |
| `secret_expired` | The signing secret passed secret_expires_at | An approver rotates the secret in the app and resumes; deploy the new secret |
| `signature_failed` | Five invalid signatures on one challenge | Build the signed string with `manza transfers sign` and the current secret |
| `stale` | The transfer, the payee's bank details or the enrolled endpoint changed after the challenge was sent | Create a new transfer; do not edit it or its payee while a challenge is open |
| `rail_limit_exceeded` | The challenge was authorized, but the transfer's rail (an instant transfer's daily cap) refused it before anything was sent | Have an approver send it on the standard rail in the app, or create the next one without the instant rail |
| `expired` | Nobody answered the challenge within one hour | Check that your receiver got the webhook (below) and called authorize |

**Does this captured webhook verify with my secret?**

Copy a delivery from the dashboard's delivery log or from ngrok's inspector: the raw body, `X-Manza-Timestamp` and `X-Manza-Signature`. Save the body byte for byte (no reformatting, no trailing newline):

```bash
manza webhooks verify --secret-env WEBHOOK_SECRET --timestamp 1767225600 \
  --signature 970fdd13680015f73dbd172884498c6fd1e07d5b5c41aae081272598607fea75 \
  --file body.json --no-tolerance
```

It prints `valid` and exits 0, or prints the reason (`invalid webhook signature`, `webhook timestamp outside tolerance`, …) on stderr and exits 1. Without `--file` it reads the body from stdin. `--secret-env` names the environment variable holding the endpoint's signing secret; `--secret <secret>` also works but shows in `ps` and your shell history. A delivery older than 5 minutes fails the timestamp check unless you pass `--no-tolerance`; never skip that check in a live receiver.

## Forwarding webhooks to localhost

`manza listen` opens a listen session and forwards every subscribed webhook to a server on your machine, the way `stripe listen` does. Your registered endpoints keep receiving everything too.

```bash
manza listen --forward-to http://localhost:4242/webhooks
manza listen --forward-to http://localhost:4242/webhooks --events transfer.executed,payment_link.paid
manza listen --forward-to http://localhost:4242/webhooks --authorizer
```

```text
Ready! Listening for all events. Your listen signing secret is whsec_… (^C to quit)
2026-11-18 16:44:33  --> transfer.executed [0199a1b2-0000-7000-8000-000000000010]
2026-11-18 16:44:33  <-- [200] POST http://localhost:4242/webhooks (12 ms)
```

- Each request carries the body byte for byte, signed like a real delivery (`X-Manza-Signature`, `X-Manza-Timestamp`, `X-Manza-Event`, `X-Manza-Event-Id`, `X-Manza-Delivery-Id`, and the same under `X-Zazu-*`) but with your API key's **listen signing secret**, not an endpoint's secret. Verify with it as you would in production. It is signed when forwarded, so an event replayed after a reconnect still passes the 5-minute timestamp check.
- `manza listen --print-secret` prints only that secret and exits, for `.env` files: `echo "WEBHOOK_SECRET=$(manza listen --print-secret)" >> .env`. It is the same for every session of the key.
- The key needs `webhook_listeners:write`. `--authorizer` also forwards transfer-authorization challenges and needs `transfers:authorize` and an IP allowlist. The challenge still goes to your registered authorizer: the first answer wins, and five bad signatures from any answerer suspend the authorizer for everyone using it.
- A failed POST prints `<-- [500]` or `<-- [ERR] <reason>` and is not retried. Requests time out after 10 s, and redirects are not followed.
- Log lines go to stderr. `--format json` prints one line per forwarded event on stdout: `{"event_id","event_type","status","duration_ms"}`, with `status: null` and an `error` when the request failed.
- ^C closes the session. Sessions last 12 hours; at expiry the CLI opens a new one (`Session renewed`), and an event emitted between the two is not forwarded. Revoking the key or closing the session elsewhere ends the command with exit 1.

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
manza invoices create [--data json|--file path|--stdin] [--account-id id] [--generate-payment-link true|false] [invoice flags]
manza invoices update <id> [--data json|--file path|--stdin] [--account-id id] [--generate-payment-link true|false] [invoice flags]
manza invoices send <id>
manza invoices mark-as-paid <id>
manza invoices cancel <id>
manza invoices credit-note <id>
manza invoices delete <id>

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
manza webhook-endpoints retry-failed <id>

manza webhook-deliveries list <endpoint-id> [--status failed|pending|succeeded] [--limit n] [--cursor value] [--all|--max-items n]
manza webhook-deliveries get <id>
manza webhook-deliveries retry <id>

manza webhooks verify (--secret-env <VAR>|--secret <secret>) --timestamp <t> --signature <hex> [--file path] [--no-tolerance]

manza listen --forward-to <url> [--events type,type] [--authorizer]
manza listen --print-secret

manza checkout-sessions create [--data json|--file path|--stdin] [--account-id id] [--amount amount] [--currency-code value] [--success-url url] [--cancel-url url] [--description text] [--customer-email email] [--metadata json]
manza checkout-sessions get <id>

manza transfers create [--data json|--file path|--stdin] [transfer flags] [--client-reference ref] [--transfer-method method]
manza transfers get <id>
manza transfers authorize <id> --authorization-id <id> --signature <hex>
manza transfers decline <id> --authorization-id <id> [--reason text]
manza transfers sign --secret-env <VAR> --payment-id <id> --nonce <nonce> --amount <decimal> --currency-code <code> --account-id <id> (--external-account-id <id>|--destination-account-id <id>) [--client-reference ref] [--transfer-method method]

manza transfer-authorizer get

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
