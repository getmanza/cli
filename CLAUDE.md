# @getzazu/cli

Command-line interface for the Zazu API. Single-file TypeScript source in `bin/zazu.ts`, compiled to a self-contained Bun binary so end users don't need a runtime installed.

## Stack

| Concern | Tool | Notes |
|---|---|---|
| Language | TypeScript 5.x | `tsconfig.json` |
| Build / package mgmt / test runner | Bun 1.3+ | `bun build`, `bun test`, `bun install` |
| Lint + format | Biome 2.x | `biome.json`. Replaces eslint + prettier |
| Type-check | `tsc --noEmit` | Bun doesn't do this; we keep tsc for it |
| HTTP / errors / pagination | `@getzazu/sdk` | The CLI is a thin wrapper over the SDK |
| Distribution | Standalone binaries via `bun build --compile` + per-platform npm packages | `scripts/build`, `scripts/npm-publish` |

## Public surface

| Command | Purpose |
|---|---|
| `zazu login` / `logout` / `config` | API key + base URL storage in `~/.config/zazu/config.json` |
| `zazu entity get` | Fetch the entity record |
| `zazu accounts list/get/transactions/transaction` | Account + transaction reads |
| `zazu customers list/get/create/update/delete` | Customer CRUD |
| `zazu invoices list/get/create/update/send/mark-as-paid/cancel/credit-note/delete/payment-link` | Invoice ops |
| `zazu payment-links list/get/create/cancel` | Payment-link ops |
| `zazu webhook-endpoints list/get/create/update/delete/test/regenerate-secret/enable/disable` | Webhook config |
| `zazu request <method> <path>` | Escape hatch for raw API calls |

Global flags: `--api-key`, `--api-key-stdin`, `--base-url`, `--api-version`, `--timeout-ms`, `--format` (json/pretty/raw), `--output`, `--debug`, `--help`, `--version`, `--quiet`. List flags add `--all`, `--cursor`, `--limit`, `--max-items`.

## How to work in this codebase

1. **The CLI is a thin wrapper.** HTTP, retries, pagination, error mapping, JSON parsing — all in `@getzazu/sdk`. The CLI's job is argv parsing, output formatting, token storage, and login/config commands.
2. **Tests are integration-style.** `test/cli.test.js` spawns the actual CLI binary and asserts stdout/stderr/exit codes. No unit tests on individual functions — the contract is at the CLI boundary.
3. **One file in `bin/`, by design.** `bin/zazu.ts` is intentionally a single TypeScript file. Bun compiles it directly. Resist the urge to split it into modules until there's a forcing function.
4. **Lint must be green.** `bun run lint` runs Biome with `--error-on-warnings`. Don't add `// biome-ignore` to silence — fix the issue.

## Critical rules

- **Use the SDK.** Don't hand-roll `fetch` calls. Don't parse `error.message` for status codes — use `instanceof ZazuValidationError` etc.
- **`bun run check:all` before every commit.** Runs typecheck + lint + test. CI runs the same commands.
- **No long-lived `NPM_TOKEN`.** Releases publish via npm OIDC trusted publishing through the `release` GitHub environment. Each of the **five** published packages — `@getzazu/cli`, `@getzazu/cli-darwin-arm64`, `@getzazu/cli-darwin-x64`, `@getzazu/cli-linux-arm64`, `@getzazu/cli-linux-x64` — has its own trusted-publisher binding at `https://www.npmjs.com/package/<name>/access`. All five point at this repo's `release.yml` workflow + `release` environment. Adding a new platform target means adding a fifth, sixth, etc. binding before its first publish.
- **Per-platform packages, not a JS shim.** The published `@getzazu/cli` is a resolver that delegates to `@getzazu/cli-darwin-arm64` / `cli-darwin-x64` / `cli-linux-arm64` / `cli-linux-x64`. Same pattern as esbuild, swc, biome, turbo. Don't bundle the binary into the parent package.
- **Backwards-compatible config layout.** `~/.config/zazu/config.json` is read by every CLI version. Don't change the schema without a migration path.
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
bun run compile                  # standalone binary at dist/zazu
./dist/zazu --version            # smoke test
bun run build                    # cross-compile all 4 targets (slow)

# Release (after PR merge)
# Tag on GitHub triggers .github/workflows/release.yml which:
#   1. cross-compiles all four binaries
#   2. publishes the four @getzazu/cli-<arch> platform packages
#   3. publishes @getzazu/cli (the resolver shim)
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

The CLI consumes `@getzazu/sdk`, which mirrors `zazu-ruby`'s public surface and replays its cassettes. If the wire format breaks, it's coordinated across at least three repos: zazu-ruby (records), zazu-ts (consumes), zazu-cli (consumes).

## Repository links

- Ruby SDK (reference): https://github.com/getzazu/zazu-ruby
- TS SDK: https://github.com/getzazu/zazu-ts (https://www.npmjs.com/package/@getzazu/sdk)
- This repo: https://github.com/getzazu/cli (https://www.npmjs.com/package/@getzazu/cli)
