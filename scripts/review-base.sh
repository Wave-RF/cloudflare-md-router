#!/usr/bin/env bash
# The ref a PR branch is reviewed against: `origin/main` (what the PR targets),
# else local `main`. Prints the ref name; exits 1 if neither resolves.
#
# Why origin/main first: in a git worktree, local `main` is shared with the
# main checkout and is often behind (nobody pulls it there), so
# `git diff main...HEAD` would sweep upstream commits the branch merged in into
# "this change". `git fetch origin main` keeps origin/main current.
#
# Single source of truth for the review base — used by
# .claude/hooks/agent-bash-gate.sh (via check-review-markers.sh),
# scripts/skip-pre-push-review.sh, scripts/docs-prose.sh, /prepush and the
# reviewer prompts.

set -u

for ref in origin/main main; do
  if git rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then
    echo "$ref"
    exit 0
  fi
done
exit 1
