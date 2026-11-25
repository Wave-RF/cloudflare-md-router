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
# so run it from the work tree being pushed. The reviewer list and the review
# base come from that work tree's scripts/ too, the same list its /prepush,
# review-marker.sh and skip script use; the copies next to this script are only
# a fallback, for when the Claude Code gate runs its own copy against a
# worktree whose branch predates review-base.sh. Shared by the Claude Code push gate
# (.claude/hooks/agent-bash-gate.sh) and the git backstop (.githooks/pre-push),
# so the two can't drift. Marker scheme: keep in sync with
# .claude/hooks/review-marker.sh and scripts/skip-pre-push-review.sh.

set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
cd "$(git rev-parse --show-toplevel)" 2>/dev/null || exit 2
helper() { if [ -f "scripts/$1" ]; then echo "scripts/$1"; else echo "$here/$1"; fi; }

sha=$(git rev-parse --verify --quiet "${1:-HEAD}^{commit}" 2>/dev/null) || {
  echo "check-review-markers: can't resolve '${1:-HEAD}' to a commit." >&2
  exit 2
}

# Nothing to review when the commit adds nothing beyond the base. No base
# resolvable, or a base git can't walk -> fail safe and check.
if base=$(bash "$(helper review-base.sh)" 2>/dev/null) \
   && commits=$(git rev-list "${base}..${sha}" 2>/dev/null) \
   && [ -z "$commits" ]; then
  exit 0
fi

# The list must come out whole: the helper succeeds, prints at least one name,
# and every name is filename-safe (it becomes part of a marker path). Any bad
# entry rejects the whole list, so a corrupt manifest can't quietly drop a
# reviewer from the gate.
corrupt() {
  echo "check-review-markers: scripts/pre-push-reviewers.sh $1 — can't tell which reviews gate this push." >&2
  exit 2
}
reviewers=$(bash "$(helper pre-push-reviewers.sh)" 2>/dev/null) || corrupt "failed (missing, unreadable, or exited non-zero)"
[ -n "$reviewers" ] || corrupt "printed no reviewer names"
if bad=$(printf '%s\n' "$reviewers" | grep -vE '^[A-Za-z0-9._-]+$'); then
  corrupt "printed an invalid reviewer name ($(printf '%s' "$bad" | head -n 1))"
fi

missing=0
for r in $reviewers; do
  if [ ! -f "tmp/${r}-passed-${sha}" ]; then
    echo "  - ${r} -> tmp/${r}-passed-${sha:0:8}"
    missing=1
  fi
done
exit "$missing"
