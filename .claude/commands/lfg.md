---
description: "Executes full autonomous engineering workflow with verification. Use when implementing complete features, tackling GitHub issues, or running end-to-end development cycles."
model: opus
argument-hint: "GitHub issue number/URL or feature description"
allowed-tools: Bash(gh issue view:*), Bash(gh search:*), Bash(gh issue list:*), Bash(gh pr create:*), Bash(gh pr view:*), Bash(bun:*), Bash(go:*), Bash(./dist/manza:*), Bash(git:*), Read, Write, Edit, Glob, Grep, Agent, TaskCreate, TaskUpdate, TaskList
---

# LFG — full autonomous workflow

Execute a complete engineering workflow with verification at each phase. The phases below exist because skipping any one of them has caused a production bug at least once — the checklist is load-bearing.

## Phase 0: Branch setup

1. `git branch --show-current`
2. If not on `main`: `git checkout main`
3. `git pull origin main`
4. `git checkout -b issue-{number}-{brief-description}` (or `feature/{description}` if no issue)

## Phase 1: Understand

If `$ARGUMENTS` is a GitHub issue number/URL:

```bash
gh issue view <number> --json title,body,labels,assignees,comments
```

Define explicit acceptance criteria (GIVEN / WHEN / THEN). Don't proceed until you can articulate them.

**Comprehension gate** — answer all five before writing code:

1. State the problem in one sentence.
2. Why is it needed?
3. What changes from the user's perspective?
4. What edge cases aren't explicit?
5. What data flow / code path is involved?

Use `TaskCreate` to record steps; update with `TaskUpdate` as you go.

## Phase 2: Explore

1. Find related files (Glob/Grep, or the Explore agent, `model: haiku`, for broad searches).
2. Read existing patterns in the same area of `cmd/manza/`.
3. Understand which SDK methods to call — the CLI is a thin wrapper over `manza-go` (`github.com/getmanza/manza-go`).
4. Check existing test coverage in `test/cli.test.js`.

## Phase 3: Plan

1. List files to modify.
2. List new files to create.
3. Plan test coverage (tests first).
4. Update the task list.

## Phase 4: Implement (TDD)

For each logical unit:

### 4.1 Failing test first

Tests are integration-style (spawn the CLI binary, assert stdout/stderr/exit). Add to `test/cli.test.js`. Confirm the new test fails for the right reason:

```bash
bun test test/cli.test.js
```

### 4.2 Minimum implementation

Project conventions:

| Use | Instead of |
|-----|-----------|
| `manza-go` via `sender.fetch` (`Client.Request` or a typed method) | hand-rolled `net/http` calls |
| `errors.As(err, &apiErr)` with `*manza.Error` / `Kind` | parsing error strings for status codes |
| `apiRequest{paginate: true}` via `listRequest` (`sendPaginated` walks cursors) | a new cursor loop per command |
| `printError` / `printOutput` | hand-rolling stdout/stderr JSON |
| `*object` + `stringify` from `jsjson.go` | `encoding/json` maps (they sort keys) |
| a case in `test/cli.test.js` (runs `dist/manza`); `go test` for internals | testing through Go function calls only |
| `bun run lint` (Biome, `go vet`, `gofmt`) | ad-hoc formatters |
| `npx --yes npm@latest publish` (release path) | `npm install -g npm@latest && npm publish` |

### 4.3 Refactor

Once green, refactor with tests still passing.

### 4.4 Validate

```bash
bun run check:all   # lint (Biome, go vet, gofmt) + test (go test, CLI suite)
bun run lint:fix    # Biome safe fixes + gofmt
bun run compile     # standalone binary
./dist/manza --version   # smoke
```

### 4.5 Repeat

Move to the next unit. Mark task items complete as you finish them.

## Phase 5: Deep root-cause analysis (bug fixes only)

For bug fixes, investigate before implementing:

- **Trace the data lifecycle** — where was the value created, how did it reach the failure point, what assumption broke?
- **Use git history** — `git log --oneline -20 <file>`, `git blame <file>`. Was a guard there before?
- **Map callers** — grep for callers of the failing function; does the bug only show up in one context?
- **Five whys** — keep asking "why" until you reach a meaningful fix point.

**Fix-location principle**: the best fix is rarely where the error is raised. Ask "where is the earliest point I could prevent this error?" Fix there.

**Superficial fixes to avoid**:
- `?.` chaining without understanding why the value is undefined
- `try/catch` that swallows the error
- Type assertions (`as Foo`) instead of fixing the producer
- Catching `ManzaError` and re-throwing with a generic message — preserve the subclass

## Phase 6: Verify

All must pass before committing:

```bash
bun run check:all                    # lint + test
bun run compile                      # binary builds
./dist/manza --version                # binary runs
```

Re-read the original requirements: would the requester consider this fully resolved? Have you addressed the root cause? Do the tests prove the fix?

## Phase 6.5: Fable validation

Spawn the `fable-validator` agent (it is pinned to Fable) with the issue, the acceptance criteria from Phase 1 and the base branch. On **BLOCK**, fix every blocker (back to Phase 4 for code, with a failing test first), re-verify, and run the validator again. On **PASS WITH NOTES**, fix the risks you agree with and list the rest in the pull request under "Accepted risks". If those fixes change the diff, re-verify and run the validator again. Put the validator's one-line verdict and its "Not verified" list in the pull request body. Do not open the pull request before a PASS or PASS WITH NOTES.

## Phase 7: Commit and PR

**Backticks in PR bodies pass through `<<'EOF'` heredocs verbatim — do NOT escape them with `` \` ``.** See the "PR descriptions" section in `CLAUDE.md`.

```bash
git add <specific_files>
git commit -m "$(cat <<'EOF'
feat(scope): brief description

## Summary
[What changed and why]

## Test Coverage
- test 1: validates requirement X
- test 2: validates edge case Y

## Verification
- [x] bun run check:all
- [x] bun run compile
EOF
)"

git push -u origin $(git branch --show-current)

gh pr create --title "feat(scope): brief description" --body "$(cat <<'EOF'
## Summary
- Key change 1 — uses `Page<T>.records()` from the SDK
- Key change 2

Closes #<issue_number>

## Fable validation
Verdict: <PASS | PASS WITH NOTES>. Not verified: <list>.

## Accepted risks
<risks from the validator you did not fix, or "none">

## Test plan
- [ ] Scenario 1
- [ ] Scenario 2
EOF
)"
```

If you typed `` \` `` anywhere in the body, delete the backslash. The single-quoted EOF delimiter is doing all the shell-escaping work.

## Verification checklist

- [ ] All acceptance criteria met.
- [ ] Tests written before implementation.
- [ ] `bun run check:all` passes.
- [ ] `bun run compile` produces a working binary.
- [ ] No hand-rolled HTTP — uses the SDK.
- [ ] `fable-validator` verdict is PASS or PASS WITH NOTES (Phase 6.5), and it is in the PR body.
- [ ] Accepted risks (if any) are listed in the PR body.
- [ ] PR created with description.

## Karpathy guidelines (always)

These reduce common LLM coding mistakes. Apply on every change, not just LFG runs:

1. **Think before coding** — surface assumptions, push back on overcomplication, ask when unclear.
2. **Simplicity first** — minimum code that solves the problem, no speculative abstractions.
3. **Surgical changes** — touch only what you must; clean up your own orphans, not pre-existing dead code.
4. **Goal-driven execution** — define success criteria as a verifiable test, loop until verified.
