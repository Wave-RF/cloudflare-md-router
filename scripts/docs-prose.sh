#!/usr/bin/env bash
# Canonical "docs prose" resolver — a denylist. Every tracked *.md / *.mdx file
# IS docs prose EXCEPT the agent/governance/changelog files and the .claude /
# .github trees. New docs are picked up automatically. Single source of truth
# for the docs-reviewer gate's scope (the reviewer ALSO reads the src/ JSDoc —
# this package ships raw TypeScript, not .md, so it's handled in the agent prompt).
#
# Modes:
#   docs-prose.sh all              every docs-prose file (the full reading list)
#   docs-prose.sh changed [base]   docs-prose files changed vs base (default: main, else origin/main)
#   docs-prose.sh is-match <path>  exit 0 if <path> is docs prose, else 1

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" 2>/dev/null || exit 1

is_prose() {
  case "$1" in
    .claude/*|.github/*) return 1 ;;
    CHANGELOG.md|AGENTS.md|CLAUDE.md|RELEASING.md) return 1 ;;
    *.draft.md|*.old.md) return 1 ;;
    *.md|*.mdx) return 0 ;;
    *) return 1 ;;
  esac
}

case "${1:-all}" in
  all)
    git ls-files '*.md' '*.mdx' | while read -r f; do is_prose "$f" && echo "$f"; done
    ;;
  changed)
    base="${2:-}"
    if [ -z "$base" ]; then
      for ref in main origin/main; do
        git rev-parse --verify --quiet "$ref" >/dev/null 2>&1 && { base="$ref"; break; }
      done
    fi
    [ -z "$base" ] && exit 0
    git diff --name-only "${base}...HEAD" -- '*.md' '*.mdx' | while read -r f; do is_prose "$f" && echo "$f"; done
    ;;
  is-match)
    [ -n "${2:-}" ] || { echo "usage: $0 is-match <path>" >&2; exit 2; }
    is_prose "$2"
    ;;
  *)
    echo "usage: $0 {all|changed [base]|is-match <path>}" >&2
    exit 2
    ;;
esac
