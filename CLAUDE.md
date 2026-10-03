# @getmanza/cli

Command-line interface for the Manza API (renamed from zazu in 1.0). Single-file TypeScript source in `bin/manza.ts`, compiled to a self-contained Bun binary so end users don't need a runtime installed.

## Stack

| Concern | Tool | Notes |
|---|---|---|
| Language | TypeScript 5.x | `tsconfig.json` |
| Build / package mgmt / test runner | Bun 1.3+ | `bun build`, `bun test`, `bun install` |
| Lint + format | Biome 2.x | `biome.json`. Replaces eslint + prettier |
| Type-check | `tsc --noEmit` | Bun doesn't do this; we keep tsc for it |
| HTTP / errors / pagination | `@getmanza/sdk` | The CLI is a thin wrapper over the SDK |
| Distribution | Standalone binaries via `bun build --compile` + per-platform npm packages | `scripts/build`, `scripts/npm-publish` |

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

1. **The CLI is a thin wrapper.** HTTP, retries, pagination, error mapping, JSON parsing — all in `@getmanza/sdk`. The CLI's job is argv parsing, output formatting, token storage, and login/config commands.
2. **Tests are integration-style.** `test/cli.test.js` spawns the actual CLI binary and asserts stdout/stderr/exit codes. No unit tests on individual functions — the contract is at the CLI boundary.
3. **One file in `bin/`, by design.** `bin/manza.ts` is intentionally a single TypeScript file; `bin/zazu.ts` is only the deprecated-name shim (removed in 2.0). Bun compiles it directly. Resist the urge to split it into modules until there's a forcing function.
4. **Lint must be green.** `bun run lint` runs Biome with `--error-on-warnings`. Don't add `// biome-ignore` to silence — fix the issue.

## Critical rules

- **Use the SDK.** Don't hand-roll `fetch` calls. Don't parse `error.message` for status codes — use `instanceof ManzaValidationError` etc.
- **`bun run check:all` before every commit.** Runs typecheck + lint + test. CI runs the same commands.
- **No long-lived `NPM_TOKEN`.** Releases publish via npm OIDC trusted publishing through the `release` GitHub environment. Each of the **five** published packages — `@getmanza/cli`, `@getmanza/cli-darwin-arm64`, `@getmanza/cli-darwin-x64`, `@getmanza/cli-linux-arm64`, `@getmanza/cli-linux-x64` — needs its own trusted-publisher binding at `https://www.npmjs.com/package/<name>/access`, set up and verified before the first 1.0 release (the `@getzazu/*` bindings don't carry over). All five point at this repo's `release.yml` workflow + `release` environment. Adding a new platform target means adding a fifth, sixth, etc. binding before its first publish.
- **Per-platform packages, not a JS shim.** The published `@getmanza/cli` is a resolver that delegates to `@getmanza/cli-darwin-arm64` / `cli-darwin-x64` / `cli-linux-arm64` / `cli-linux-x64`. Same pattern as esbuild, swc, biome, turbo. Don't bundle the binary into the parent package.
- **Backwards-compatible config layout.** `~/.config/manza/config.json` is read by every 1.x+ CLI; for all of 1.x the CLI falls back to reading `~/.config/zazu/config.json` and copies it to the manza path on first write. Don't change the schema without a migration path.
- **Legacy names until 2.0.** The `zazu` command (npm + source shim), the `ZAZU_*` env vars (with a deprecation warning) and the zazu config path all keep working for 1.x. Remove them together in 2.0.
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
bun start <args>                 # run CLI from source
bun test test/cli.test.js        # while iterating
bun run check:all                # before commit (typecheck + lint + test)
bun run lint:fix                 # auto-apply Biome safe fixes

# Build verification
bun run check                    # bundle check (target=bun)
bun run compile                  # standalone binary at dist/manza
./dist/manza --version           # smoke test
bun run build                    # cross-compile all 4 targets (slow)

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

## Models

Sessions run on `opus` (Opus 5.5) with `fable` (Fable 5.1) as the advisor (`.claude/settings.json`). Fable is spent where judgment matters most: plans are written on Fable, the advisor is consulted at decision points (before choosing an approach, a schema or public API, a migration, a dependency, anything irreversible, and when a failure repeats), and the `fable-validator` agent checks every finished implementation before its pull request opens (`/lfg`, Phase 6.5). Commands pin their tier by alias, never by full model ID: `opus` for orchestration, security, full PR review, payments and production debugging; `sonnet` for the implementation specialists and TDD; `haiku` for mechanical scans. Every spawned agent names its `model:`; one that does not runs on `sonnet` (`CLAUDE_CODE_SUBAGENT_MODEL`), never on the session's model. Plan mode cannot take a model of its own: it runs on Opus and asks the advisor.

## Slash commands

These live in `.claude/commands/` and are available in any Claude Code session:

| Command | When |
|---|---|
| `/lfg <issue or feature>` | Full autonomous workflow with TDD + verification |
| `/github-review-pr <PR#>` | Full PR review pass — failures first, then comments |
| `/github-review-failures <PR#>` | Just fix CI failures on a PR |
| `/github-review-comments <PR#>` | Just respond to reviewer comments on a PR |
| `/coderabbit-review <PR#>` | Specifically address CodeRabbit findings (verify, fix valid, push back on stale/wrong) |

## Cross-SDK contract

The CLI consumes `@getmanza/sdk`, which mirrors `manza-ruby`'s public surface and replays its cassettes. If the wire format breaks, it's coordinated across at least three repos: manza-ruby (records), manza-ts (consumes), cli (consumes).

## Repository links

- Ruby SDK (reference): https://github.com/getmanza/manza-ruby
- TS SDK: https://github.com/getmanza/manza-ts (https://www.npmjs.com/package/@getmanza/sdk)
- This repo: https://github.com/getmanza/cli (https://www.npmjs.com/package/@getmanza/cli)
