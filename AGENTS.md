# @getmanza/cli

Project instructions for every agent: Claude Code (`CLAUDE.md` imports this file); other agents read this file directly. Claude's workflow comes from the `flow` plugin (`.claude/settings.json`), which acts on the facts in `## Workflow` below.

Command-line interface for the Manza API (renamed from zazu in 1.0). Go source in `cmd/manza/`, compiled to a static ~6 MB binary per platform so end users don't need a runtime installed. Ported from Bun/TypeScript in 1.1 (the Bun binaries were 60–97 MB).

## Stack

| Concern | Tool | Notes |
|---|---|---|
| Language | Go 1.26+ | `go.mod`, `cmd/manza/`; `version.go` embeds `package.json`'s version |
| HTTP / errors | `github.com/getmanza/manza-go` | The CLI is a thin wrapper over the SDK |
| Test runner | `go test` (unit) + `bun test` (CLI suite) | `test/cli.test.js` runs the compiled binary |
| Lint + format | `go vet` + `gofmt`; Biome 2.x for the JS test suite | `bun run lint` runs all three |
| Distribution | `CGO_ENABLED=0 go build` per target + per-platform npm packages | `scripts/build`, `scripts/npm-publish` |

## Public surface

| Command | Purpose |
|---|---|
| `manza login` / `logout` / `config` | API key + base URL storage in `~/.config/manza/config.json` (falls back to reading `~/.config/zazu/config.json`) |
| `manza entity get` | Fetch the entity record |
| `manza accounts list/get/transactions/transaction` | Account + transaction reads |
| `manza customers list/get/create/update/delete` | Customer CRUD |
| `manza invoices list/get/create/update/send/mark-as-paid/cancel/credit-note/delete/payment-link` | Invoice ops |
| `manza payment-links list/get/create/cancel` | Payment-link ops |
| `manza webhook-endpoints list/get/create/update/delete/test/regenerate-secret/enable/disable` | Webhook config |
| `manza checkout-sessions create/get` | Hosted checkout sessions |
| `manza transfers create/get/authorize/decline/sign` | Transfer drafts; `sign` computes the authorization signature locally from `--secret-env` |
| `manza beneficiaries list/get/create`, `beneficiaries accounts list/create <beneficiary-id>`, `beneficiaries accounts get <beneficiary-id> <account-id>` | Saved recipients + their external bank accounts |
| `manza payee-trust-requests create/get` | Ask to trust payees for machine-authorized transfers |
| `manza request <method> <path>` | Escape hatch for raw API calls |

Global flags: `--api-key`, `--api-key-stdin`, `--base-url`, `--api-version`, `--timeout-ms`, `--format` (json/pretty/raw), `--output`, `--debug`, `--help`, `--version`, `--quiet`. List flags add `--all`, `--cursor`, `--limit`, `--max-items`.

## How to work in this codebase

1. **The CLI is a thin wrapper.** HTTP, auth headers and error classification are in `manza-go`; every request goes through `Client.Request` or a typed SDK method. The CLI's job is argv parsing, output formatting, token storage, and login/config commands.
2. **Output is byte-compatible with 1.0.** The CLI was TypeScript until 1.1, and scripts parse its output. `cmd/manza/jsjson.go` keeps JavaScript's JSON semantics: key insertion order, `JSON.stringify` number and string formatting. Query strings keep flag order. Don't swap in `encoding/json` maps for output or request bodies (they sort keys), and don't use `url.Values.Encode` (it sorts too).
3. **Tests are integration-style.** `test/cli.test.js` spawns the compiled binary (`MANZA_CLI_BIN`, default `dist/manza`) against a local mock API and asserts stdout/stderr/exit codes and exact request bodies. That suite is the contract; `go test` covers only internals like `jsjson.go`.
4. **Lint must be green.** `bun run lint` runs Biome with `--error-on-warnings`, `go vet` and `gofmt`. Don't add `// biome-ignore` or `//nolint` to silence — fix the issue.

## Critical rules

- **Use the SDK.** Don't hand-roll `net/http` calls. Don't parse error strings for status codes — use `errors.As` to `*manza.Error` and its `Kind`. The `recorder` transport in `send.go` only observes responses (headers, body in key order) that the SDK doesn't expose.
- **Reuse the CLI's helpers.** Lists go through `apiRequest{paginate: true}` via `listRequest` (`sendPaginated` walks the cursors), never a new cursor loop per command; output goes through `printError` / `printOutput`, never hand-rolled stdout/stderr JSON; a SDK error keeps its `*manza.Error` and `Kind`, never re-wrapped in a generic message. A test is a case in `test/cli.test.js`; `go test` is for internals.
- **`bun run check:all` before every commit.** Runs lint (Biome, `go vet`, `gofmt`) + test (`go test`, compile, CLI suite). CI runs the same commands.
- **No long-lived `NPM_TOKEN`.** Releases publish via npm OIDC trusted publishing through the `release` GitHub environment. Each of the **five** published packages — `@getmanza/cli`, `@getmanza/cli-darwin-arm64`, `@getmanza/cli-darwin-x64`, `@getmanza/cli-linux-arm64`, `@getmanza/cli-linux-x64` — needs its own trusted-publisher binding at `https://www.npmjs.com/package/<name>/access`, set up and verified before the first 1.0 release (the `@getzazu/*` bindings don't carry over). All five point at this repo's `release.yml` workflow + `release` environment. Adding a new platform target means adding a fifth, sixth, etc. binding before its first publish.
- **Publish with `npx --yes npm@latest publish`**, not `npm install -g npm@latest && npm publish`, and no `registry-url` on `setup-node`: it writes `_authToken=${NODE_AUTH_TOKEN}` to `.npmrc`, npm then skips OIDC and a trusted-publishing publish returns 404. A user on an OS/arch outside `darwin|linux` × `arm64|x64` gets the shim's clear error; adding a target means `scripts/build` and a new trusted-publisher binding.
- **Per-platform packages, not a JS shim.** The published `@getmanza/cli` is a resolver that delegates to `@getmanza/cli-darwin-arm64` / `cli-darwin-x64` / `cli-linux-arm64` / `cli-linux-x64`. Same pattern as esbuild, swc, biome, turbo. Don't bundle the binary into the parent package.
- **Backwards-compatible config layout.** `~/.config/manza/config.json` is read by every 1.x+ CLI; for all of 1.x the CLI falls back to reading `~/.config/zazu/config.json` and copies it to the manza path on first write. Don't change the schema without a migration path.
- **Legacy names until 2.0.** The `zazu` command (npm shim, and the binary itself when invoked as `zazu`), the `ZAZU_*` env vars (with a deprecation warning) and the zazu config path all keep working for 1.x. Remove them together in 2.0.
- **Never escape backticks in PR bodies.** With `<<'EOF'` (single-quoted heredoc) the shell passes everything through verbatim. Typing `` \` `` produces literal `` \` `` in the rendered PR. See "PR descriptions" below.

## PR descriptions

Write PR description bodies in plain Markdown. **Do not escape backticks** with `` \` `` — GitHub renders `` \` `` literally as a backslash followed by a backtick, producing output like `` \`Page<T>\` `` instead of the monospace `Page<T>` the reader expects.

The usual cause is writing the description inside a bash heredoc (`gh pr create --body "$(cat <<'EOF' ... EOF)"`) and then reflexively escaping every backtick because of shell-quoting muscle memory. With `<<'EOF'` (single-quoted delimiter) the shell does NOT interpret anything inside the heredoc — backticks, dollars, and backslashes all pass through verbatim. So write them exactly as you want them rendered:

```bash
# Good — renders as `Page<T>` in monospace
gh pr create --body "$(cat <<'EOF'
Uses the `Page<T>` helper.
EOF
)"

# Bad — renders as \`Page<T>\` literally in the PR body
gh pr create --body "$(cat <<'EOF'
Uses the \`Page<T>\` helper.
EOF
)"
```

Same rule for code blocks — write triple-backticks unescaped. The single-quoted heredoc delimiter is doing all the shell-escaping work. If you find yourself typing `` \` `` inside a PR body, stop and remove the backslash.

## Striving for excellence

These are the Karpathy guidelines we apply on every change. They reduce common LLM coding mistakes.

### 1. Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Senior engineer test: would they call this overcomplicated?

### 3. Surgical changes

Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that *your* changes orphaned. Don't remove pre-existing dead code unless asked.

### 4. Goal-driven execution

Define success criteria. Loop until verified.

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan with verification at each step.

## Development workflow

```bash
# One-time setup
bun install

# Daily loop
go run ./cmd/manza <args>        # run CLI from source
bun run compile && bun test      # while iterating (the suite runs dist/manza)
bun run check:all                # before commit (lint + test)
bun run lint:fix                 # Biome safe fixes + gofmt

# Build verification
bun run compile                  # binary for this platform at dist/manza
./dist/manza --version           # smoke test
scripts/build                    # cross-compile all 4 targets

# Release (after PR merge, from a clean, up-to-date main)
bin/release list        # last releases + what patch/minor/major would give
bin/release --dry-run   # version + changes since the last tag, publishes nothing
bin/release minor       # or patch (default), major, an explicit 0.3.0; --force re-creates
# → bumps package.json, runs check:all, pushes main, publishes the GH release
# Tag on GitHub triggers .github/workflows/release.yml which:
#   1. cross-compiles all four binaries
#   2. publishes the four @getmanza/cli-<arch> platform packages
#   3. publishes @getmanza/cli (the resolver shim)
```

## Workflow

- **Verify:** `bun run check:all` (Biome `--error-on-warnings`, `go vet`, `gofmt`, `go test`, compile, CLI suite) · `bun run compile && ./dist/manza --version`
- **Specs:** fast loop `bun run compile && bun test test/cli.test.js` (bare `bun test` runs a stale `dist/manza`); full suite `bun run test`; two worktrees at once: yes (the suite uses a local mock API, no shared state)
- **CI:** required none; jobs `test` (lint, `bun run test`, smoke, staging smoke) and `build` (`scripts/build`, all four targets) in `ci.yml`, check `cubic · AI code reviewer`; full suite on the PR; failure report none
- **Review bot:** cubic; push back, citing this file, on mocks instead of the compiled-binary suite, `encoding/json` maps (they sort keys), `// biome-ignore` / `//nolint`, speculative abstractions
- **Merge:** squash — `gh pr merge <PR> --squash --delete-branch`; fallback after the gate: `--admin` for the required approving review
- **PR contract:** `## Summary` (`Closes #N`), `## Fable validation` (verdict, Not verified), `## Test plan`; backticks unescaped (below); labels none; screenshots none
- **Conflicts:** `package.json` `version` — main's; `bun.lock` — main's, then `bun install`; `bin/release`, `scripts/{version,release-check,build,npm-publish}`, `.github/workflows/release.yml` — main's (release kit, never edited in place)
- **Worktree setup:** `bun install --frozen-lockfile`; undo none
- **Release:** `bin/release [patch|minor|major|X.Y.Z]` from a clean, current main (prompts y/N) → tag fires `release.yml`; changelog none
- **Main health:** `gh run list --workflow ci.yml --branch main --event push --limit 1 --json conclusion,headSha`
- **Upstream:** libraries we own `getmanza/*`, `zoolutions/*`; scrub none
- **Bench:** none

## Agent commands

The workflow commands are the `flow` plugin's (`/flow:lfg`, `/flow:github-review-pr`, `/flow:plan`, …); this repository has no local commands.

## Cross-SDK contract

The CLI consumes `manza-go`, which mirrors `manza-ruby`'s public surface and replays its cassettes. If the wire format breaks, it's coordinated across at least three repos: manza-ruby (records), manza-go (consumes), cli (consumes).

## Repository links

- Ruby SDK (reference): https://github.com/getmanza/manza-ruby
- Go SDK: https://github.com/getmanza/manza-go (`github.com/getmanza/manza-go`)
- This repo: https://github.com/getmanza/cli (https://www.npmjs.com/package/@getmanza/cli)
