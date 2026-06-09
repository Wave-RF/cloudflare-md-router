#!/usr/bin/env bash
# Tree-keyed validation marker. `pnpm run verify` (biome check + tsc --noEmit)
# writes tmp/verify-passed-tree-<TREE>; the pre-commit hook skips re-running
# verify when the marker is current, and the pre-push hook requires it for each
# pushed commit's tree. Tree-keyed (not commit-keyed) so verify → commit → push
# needs no re-run when the tree is unchanged. Skipped on CI runners ($CI set).

set -euo pipefail
cd "$(git rev-parse --show-toplevel)" 2>/dev/null || exit 1

usage() {
  echo "usage: $0 {write|has-marker|path-for-commit <sha>}" >&2
  exit 2
}

# Tree SHA of "what `git add -A && git commit` would produce now" — computed
# against a throwaway index so the real index/working dir stay untouched.
tree_of_working_dir() {
  local tmp_idx
  tmp_idx=$(mktemp); rm -f "$tmp_idx"
  trap "rm -f '$tmp_idx'" EXIT
  export GIT_INDEX_FILE="$tmp_idx"
  git read-tree HEAD
  git add -A
  git write-tree
}

case "${1:-}" in
  write)
    [ -n "${CI:-}" ] && exit 0
    mkdir -p tmp
    touch "tmp/verify-passed-tree-$(tree_of_working_dir)"
    ;;
  has-marker)
    [ -f "tmp/verify-passed-tree-$(tree_of_working_dir)" ] && exit 0
    exit 1
    ;;
  path-for-commit)
    [ -n "${2:-}" ] || usage
    echo "tmp/verify-passed-tree-$(git rev-parse "$2^{tree}")"
    ;;
  *) usage ;;
esac
