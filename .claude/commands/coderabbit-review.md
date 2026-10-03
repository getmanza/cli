---
description: "Address CodeRabbit feedback on a PR. Verify each finding against current code, fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate."
model: opus
argument-hint: "PR number (e.g., 1690 or #1690)"
allowed-tools: Bash(gh pr view:*), Bash(gh pr checks:*), Bash(gh pr diff:*), Bash(gh api:*), Bash(git log:*), Bash(git blame:*), Bash(git push:*), Bash(git commit:*), Bash(git add:*), Bash(bun:*), Bash(./dist/manza:*), Read, Write, Edit, Glob, Grep, Agent
---

# Address CodeRabbit Findings: $ARGUMENTS

CodeRabbit produces many findings per PR. Some are real bugs, many are stylistic, some are stale (the code already moved on), and a few are wrong (CodeRabbit doesn't know our conventions).

The job: **verify each finding against current code, fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.**

This is a thin wrapper over `/github-review-comments` that pre-filters to CodeRabbit's bot user and biases toward push-back over compliance. CodeRabbit is a useful second pair of eyes, not a style authority.

## Phase 0: Determine the PR

Number → PR. `#N` → strip `#`. Empty → current branch (`gh pr view --json number`).

## Phase 1: Pull CodeRabbit findings

Use GraphQL — REST doesn't expose thread resolution state, and CodeRabbit auto-resolves threads when its suggestions land in a later commit:

```bash
gh api graphql -f query='
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          path
          line
          comments(first: 1) {
            nodes {
              databaseId
              author { login }
              body
            }
          }
        }
      }
    }
  }
}' -F owner=<owner> -F repo=<repo> -F number=<PR> \
  --jq '.data.repository.pullRequest.reviewThreads.nodes
        | map(select(.isResolved == false and .comments.nodes[0].author.login == "coderabbitai"))
        | map({thread_id: .id, comment_id: .comments.nodes[0].databaseId, path, line, body: (.comments.nodes[0].body | .[:300])})'
```

CodeRabbit comments include severity markers (`🔴 Critical`, `🟡 Minor`, `🟢 Nitpick`, `⚡ Quick win`). Sort by severity — critical first, nitpicks last.

## Phase 2: Per-finding workflow

For each finding:

### 2.1 Read the actual code

```bash
# What the file looks like RIGHT NOW, not what CodeRabbit saw:
sed -n '<start>,<end>p' <path>
```

CodeRabbit comments persist across force-pushes. The cited line might already have been changed.

### 2.2 Verify the finding is still valid

A finding is **valid** when all four hold:

1. The cited code still exists as described.
2. The issue would fail a test, block a build, or cause a real bug — not just a style preference.
3. The fix doesn't conflict with `CLAUDE.md` conventions.
4. The fix is minimal — touches the cited lines and the immediate fix scope, nothing else.

A finding is **invalid / skip-with-reason** when any of:

- The code has already been changed.
- The "issue" is a stylistic preference Biome doesn't enforce.
- The suggested fix is more complex than the original code.
- The suggested fix would break a documented convention or test.
- The suggestion treats a symptom while we already handle the root cause elsewhere.

### 2.3 Apply

**Valid** → fix minimally:

- Don't refactor adjacent code.
- Don't "improve" formatting Biome already passed.
- Verify with `bun run check:all` after each fix.

**Invalid** → skip with a reason in the reply.

### 2.4 Reply on the thread

```bash
gh api repos/{owner}/{repo}/pulls/<PR>/comments/<comment_id>/replies \
  -f body='<reply>'
```

Optionally mark the thread resolved when the work is committed:

```bash
gh api graphql -f query='
mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) {
    thread { isResolved }
  }
}' -F id=<thread_id>
```

**Reply templates** (be specific — vague replies make CodeRabbit re-flag the same thing later):

- **Fixed**: "Fixed in `<sha>`. <one-line summary>."
- **Skipped — already addressed**: "Already handled in `<sha>` (HEAD shows `<line>`)."
- **Skipped — convention**: "Disagree — our convention is `<X>`, see `CLAUDE.md` § `<Y>`. Leaving as-is."
- **Skipped — out of scope**: "Out of scope for this PR. Tracked separately as `<issue/note>`."
- **Skipped — stylistic**: "Biome's ruleset already covers what we want; this would add complexity for no behavior change."
- **Partial**: "Addressed `<part>` in `<sha>`; deferring `<part>` because <reason>."

## Phase 3: Commit + push

Group commits by theme, conventional-commit prefixes:

```bash
git add <files>
git commit -m "fix(<scope>): <one-line summary>

Addresses CodeRabbit feedback on PR #<N>:
- <finding 1 summary>
- <finding 2 summary>"

git push origin <branch>
```

One commit per theme. Don't squash unrelated findings — when one regresses, you want to revert one commit, not all of them.

## Phase 4: Verify

```bash
bun run check:all            # local verification before pushing
gh pr checks <PR> --watch    # CI green after the new commits
```

Re-run the GraphQL query from Phase 1. The result should be empty (or contain only threads you've decided to defer with a documented reason).

## When to push back hard

CodeRabbit doesn't know:
- The Karpathy guidelines we follow (no speculative abstractions, surgical changes).
- That the CLI is a thin wrapper over `@getmanza/sdk` — sometimes it suggests hand-rolling logic the SDK already handles.
- The per-platform package layout in `scripts/npm-publish` — sometimes it suggests "simplifying" by bundling the binary into the parent package.
- The `bun:test` API differences from Jest — its suggestions are sometimes Jest-flavored.

When CodeRabbit suggests something that would violate one of these, push back with a one-line explanation. Don't capitulate to keep the PR quiet.

## Karpathy guidelines

Especially relevant:
- **Think before coding** — verify before fixing.
- **Simplicity first** — reject suggestions that add complexity for marginal gain.
- **Surgical changes** — only what the comment cites.
