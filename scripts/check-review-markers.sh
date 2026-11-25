#!/usr/bin/env bash
# Which pre-push review markers are missing for a commit?
#
#   scripts/check-review-markers.sh [<sha>]     (default: HEAD)
#
# Prints one line per missing marker ("  - <reviewer> -> tmp/<reviewer>-passed-<sha8>")
# and exits:
#   0  every reviewer in scripts/pre-push-reviewers.sh has tmp/<name>-passed-<sha>,
#      or <sha> has no commits beyond the review base (nothing to review)
#   1  at least one marker is missing (listed on stdout)
#   2  the reviewer list is missing/empty/corrupt (fail closed: can't tell what gates)
#
# Markers live in the CURRENT work tree's tmp/ (each git worktree has its own),
# so run it from the work tree being pushed. The reviewer list and review base
# come from the scripts next to this one, so the Claude Code gate can run its
# own copy against a worktree whose branch predates these scripts. Shared by the Claude Code push gate
# (.claude/hooks/agent-bash-gate.sh) and the git backstop (.githooks/pre-push),
# so the two can't drift. Marker scheme: keep in sync with
# .claude/hooks/review-marker.sh and scripts/skip-pre-push-review.sh.

set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
cd "$(git rev-parse --show-toplevel)" 2>/dev/null || exit 2

sha=$(git rev-parse --verify --quiet "${1:-HEAD}^{commit}" 2>/dev/null) || {
  echo "check-review-markers: can't resolve '${1:-HEAD}' to a commit." >&2
  exit 2
}

# Nothing to review when the commit adds nothing beyond the base. No base
# resolvable -> fail safe and check.
if base=$(bash "$here/review-base.sh" 2>/dev/null) \
   && [ -z "$(git rev-list "${base}..${sha}" 2>/dev/null)" ]; then
  exit 0
fi

# Validate each name for filename-safety before building a marker path.
reviewers=$(bash "$here/pre-push-reviewers.sh" 2>/dev/null | grep -E '^[A-Za-z0-9._-]+$')
if [ -z "$reviewers" ]; then
  echo "check-review-markers: scripts/pre-push-reviewers.sh produced no valid reviewer names (missing, unreadable, empty, or corrupt)." >&2
  exit 2
fi

missing=0
for r in $reviewers; do
  if [ ! -f "tmp/${r}-passed-${sha}" ]; then
    echo "  - ${r} -> tmp/${r}-passed-${sha:0:8}"
    missing=1
  fi
done
exit "$missing"
