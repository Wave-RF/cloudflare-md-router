#!/usr/bin/env bash
# Run the repo's /prepush in a headless Claude Code process started at the root
# of THIS work tree (the main checkout or any git worktree of it).
#
#   scripts/prepush-headless.sh [all] [-- <extra claude args>]
#
# Why: Claude Code loads project agents (.claude/agents/), commands
# (.claude/commands/) and hooks (.claude/settings.json) from the directory the
# session started in. An agent whose session started elsewhere — another repo,
# a parent directory — has none of them: it can't launch the real reviewer
# subagent types, and the SubagentStop hook that writes the review markers never
# runs. Emulating the reviewers with general-purpose agents produces no markers.
# This starts a fresh `claude -p` here, so the real /prepush, the real reviewer
# agents and review-marker.sh all load, and markers are written legitimately.
#
# The nested run only reviews: it launches the reviewers /prepush keeps (and
# records skips with scripts/skip-pre-push-review.sh), reports their findings,
# and stops. It does not edit, commit, push or loop — fixing findings and
# re-running this until every reviewer says ship_it is the caller's job.
#
# Prints the nested run's report, then the marker check for HEAD. Exits 0 when
# every reviewer in scripts/pre-push-reviewers.sh has a marker for HEAD, 1 when
# some are missing (address the findings, commit, run again), 2 on a usage or
# precondition error, 127 when the `claude` CLI isn't installed.

set -uo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "prepush-headless: not inside a git work tree." >&2
  exit 2
}
cd "$root" || exit 2

if ! command -v claude >/dev/null 2>&1; then
  cat >&2 <<'EOF'
prepush-headless: the Claude Code CLI (`claude`) is not on PATH, so the
pre-push reviewers can't run here. Install it (https://docs.claude.com/en/docs/claude-code),
or run /prepush in an interactive Claude Code session started in this
directory. Don't hand-write markers (AGENTS.md §"Don't bypass the gates").
EOF
  exit 127
fi

scope=""
if [ "${1:-}" = "all" ]; then
  scope="all"
  shift
fi
if [ "${1:-}" = "--" ]; then
  shift
elif [ $# -gt 0 ]; then
  echo "prepush-headless: usage: $0 [all] [-- <extra claude args>]" >&2
  exit 2
fi

# /prepush's preconditions: the review is keyed to HEAD, so the work must be
# committed; the push will also need verify's tree marker.
if [ -n "$(git status --porcelain)" ]; then
  echo "prepush-headless: uncommitted changes — commit first (reviews and markers are keyed to HEAD)." >&2
  exit 2
fi
if ! bash scripts/ci-marker.sh has-marker 2>/dev/null; then
  echo "prepush-headless: note: 'pnpm run verify' hasn't passed for this tree yet; the push will need it." >&2
fi

# Review against a current origin/main (scripts/review-base.sh). Best effort:
# offline, the existing remote-tracking ref is used.
git fetch --quiet origin main 2>/dev/null || true

headless_note='You are running /prepush headlessly on behalf of another agent, which will fix findings itself.
This script already ran `git fetch origin main`, so origin/main is current.
Do steps 1-4 of /prepush exactly once: launch every reviewer you keep in parallel with the Agent tool,
subagent_type set to the reviewer name (never a general-purpose stand-in: only the real reviewer type
gets its marker written), and record each skip with scripts/skip-pre-push-review.sh. Do NOT edit files,
commit, push, or loop (step 5 is the caller'"'"'s job). End with, for each reviewer: ran or skipped (and
why), its VERDICT line, and its findings verbatim.'

# Least privilege for a review: read-only git/gh and the review scripts. No
# Edit/Write. dontAsk denies anything not allowed instead of waiting on a prompt
# nobody can answer.
allowed=(
  Read Glob Grep Agent
  "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" "Bash(git status:*)"
  "Bash(git rev-parse:*)" "Bash(git rev-list:*)" "Bash(git merge-base:*)"
  "Bash(git ls-files:*)" "Bash(git branch:*)" "Bash(git blame:*)" "Bash(git grep:*)"
  "Bash(gh pr view:*)" "Bash(gh pr checks:*)" "Bash(gh pr diff:*)" "Bash(gh pr list:*)"
  "Bash(gh issue view:*)" "Bash(git fetch --quiet origin main)"
  # Read endpoints the reviewer prompts name. `*` (not `:*`) so the pattern can
  # continue straight into the path: `repos/:*` would need a space after `/`.
  "Bash(gh api repos/*/pulls/*/comments*)" "Bash(gh api repos/*/pulls/*/reviews*)"
  "Bash(gh api repos/*/issues/*/comments*)"
  "Bash(scripts/pre-push-reviewers.sh)" "Bash(scripts/review-base.sh)"
  "Bash(scripts/docs-prose.sh:*)" "Bash(scripts/skip-pre-push-review.sh:*)"
  "Bash(bash scripts/pre-push-reviewers.sh)" "Bash(bash scripts/review-base.sh)"
  "Bash(bash scripts/docs-prose.sh:*)" "Bash(bash scripts/skip-pre-push-review.sh:*)"
  "Bash(ls:*)" "Bash(wc:*)" "Bash(head:*)" "Bash(tail:*)" "Bash(cat:*)" "Bash(grep:*)" "Bash(rg:*)"
)

echo "prepush-headless: running /prepush ${scope} in ${root} (headless Claude Code)…" >&2
claude -p "/prepush ${scope}" \
  --permission-mode dontAsk \
  --allowedTools "${allowed[@]}" \
  --disallowedTools Edit Write NotebookEdit \
  --append-system-prompt "$headless_note" \
  "$@"
claude_status=$?
if [ "$claude_status" != 0 ]; then
  echo "prepush-headless: claude exited ${claude_status}." >&2
fi

echo >&2
if missing=$(bash scripts/check-review-markers.sh HEAD); then
  echo "✅ prepush-headless: every pre-push reviewer has a marker for HEAD $(git rev-parse --short=8 HEAD)." >&2
  ls tmp/*-passed-"$(git rev-parse HEAD)" 2>/dev/null | sed 's/^/    /' >&2
  exit 0
fi
echo "🛑 prepush-headless: still missing for HEAD $(git rev-parse --short=8 HEAD):" >&2
printf '%s\n' "$missing" >&2
echo "Address the findings above, commit, and run this again." >&2
exit 1
