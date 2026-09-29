---
description: "Use when CI checks are failing on a PR — fetches failure logs, diagnoses root causes, implements fixes, pushes until CI is green."
model: opus
argument-hint: "PR number (e.g., 1690 or #1690)"
allowed-tools: Bash(gh pr view:*), Bash(gh pr checks:*), Bash(gh pr diff:*), Bash(gh api:*), Bash(gh run view:*), Bash(git log:*), Bash(git diff:*), Bash(git push:*), Bash(git commit:*), Bash(git add:*), Bash(bun:*), Bash(./dist/zazu:*), Read, Write, Edit, Glob, Grep, Agent
---

# Fix GitHub CI Failures: $ARGUMENTS

Diagnose and fix CI failures. Work systematically: identify failures → read logs → diagnose root cause → fix locally → verify → push.

## Phase 0: Determine the PR

Number → PR. `#N` → strip `#`. Empty → current branch (`gh pr view --json number`).

## Phase 1: Inventory failures

```bash
gh pr checks <PR>
```

For each failing check, get the run id and load the failed logs:

```bash
gh run view <run-id> --log-failed
```

Categorize:
- **Test failures** — assertion failed, timeout, child-process exit code mismatch
- **Lint failures** — Biome rule violation, unused imports
- **Typecheck failures** — `tsc --noEmit` errors
- **Bundle / compile failures** — `bun build --target=bun` or `bun build --compile` failed
- **Cross-compile failures** — `scripts/build` failed for one of the four targets
- **Smoke-test failures** — `./dist/zazu --version` or staging API smoke test
- **npm-publish failures** — OIDC, sigstore, per-platform package layout
- **Security failures** — `npm audit signatures` or similar

## Phase 2: Diagnose

Read the actual error message, not the surrounding noise. The first stacktrace line that points at our code is usually the culprit.

For each failure:

### Reproduce locally

```bash
# Test
bun test test/cli.test.js

# Lint
bun run lint

# Typecheck
bun run typecheck

# Bundle check
bun run check

# Standalone binary
bun run compile
./dist/zazu --version

# Cross-compile (slow — only if the build job failed)
bun run build

# Full pipeline
bun run check:all
```

If you can't reproduce locally, the failure is environmental (CI-only):
- Different Bun version → check `.bun-version` and the workflow `bun-version-file`
- Missing dependency → did `bun install --frozen-lockfile` run before the failing step?
- Network → external service (npm registry, staging API) hiccup
- Secret missing → e.g. trusted-publishing OIDC environment, ZAZU_STAGING_* secrets
- Cross-compile target — need a Linux runner for `linux-*` targets

### Find the root cause

Apply the five-whys ladder until you reach a fix point that prevents the same class of failure recurring. Don't:

- Disable the failing test
- Add a `// biome-ignore` to silence the linter
- Cast away the type error with `as any`
- Catch and swallow `ZazuError` to make a smoke test pass

These hide the failure; the underlying bug returns elsewhere.

## Phase 3: Fix and verify

### 3.1 Implement the fix

Touch only what the failure cites, plus what the fix requires.

### 3.2 Run the equivalent local check

The CI step that failed has a local equivalent — run it, get green:

| CI step | Local equivalent |
|---|---|
| `bun run typecheck` | `bun run typecheck` |
| `bun run lint` | `bun run lint` |
| `bun run check` | `bun run check` |
| `bun test` | `bun test` |
| `bun run compile` | `bun run compile` |
| `bun run build` | `bun run build` (slow — all 4 targets) |
| `./dist/zazu --version` | `./dist/zazu --version` |
| Smoke test against staging | requires secrets — skip locally, verify via post-push CI |
| `scripts/npm-publish` | requires NODE_AUTH_TOKEN + VERSION — verify via release workflow |

### 3.3 Run the full pipeline

```bash
bun run check:all
```

### 3.4 Commit + push

```bash
git add <files>
git commit -m "fix(ci): <what was failing>

<root cause and how this addresses it>"
git push origin <branch>
```

Use `fix:` for prod fixes, `chore(ci):` for workflow / config changes.

## Phase 4: Watch the next run

```bash
gh pr checks <PR> --watch
# or
gh run watch <run-id> --exit-status
```

Track until green. If the same step fails again with a different error, repeat. If it fails the same way, your fix is wrong — revert and rethink.

## Phase 5: Verify and document

```bash
gh pr checks <PR>            # all green
gh pr view <PR> --json mergeable,reviewDecision
```

If the failure was CI-config drift (workflow YAML out of sync with reality), also update relevant docs:
- `.bun-version`
- `package.json` `engines`
- `CLAUDE.md` if a convention changed

## Common patterns and fixes

### Bundle check fails with "Could not resolve: '@getzazu/sdk'"

CI lacks a `bun install --frozen-lockfile` step before `bun run check`. Add one to the workflow.

### Trusted-publishing returned 404 from npm

`setup-node`'s `registry-url` writes `_authToken=${NODE_AUTH_TOKEN}` to `.npmrc`, which makes npm skip OIDC. Drop `registry-url`, run `npx --yes npm@latest publish` so OIDC kicks in.

### Per-platform package install fails on user's machine

The user's OS/arch isn't in our matrix (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`). The shim in `scripts/npm-publish` prints a clear error; add the missing target to `scripts/build` if it's worth supporting.

### Cross-compile `linux-*` fails on macOS host

`bun build --compile --target=bun-linux-*` works from macOS. If it fails, the cause is usually a transitive native dep with no Linux build — check `bun pm ls` for native modules.

## Karpathy guidelines

- **Think before coding** — read the actual error, don't pattern-match on the first guess.
- **Goal-driven execution** — the green CI check is the verification.
- **Surgical changes** — fix the failing class of error, not adjacent things.
