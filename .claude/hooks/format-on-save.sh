#!/usr/bin/env bash
# PostToolUse hook: auto-format edited JS/TS/JSON files with Biome after edits.
#
# Why a hook: catches format drift at write time so commits never carry
# fmt-failing files (the `biome check` step in `pnpm run verify` — and thus the
# pre-commit hook and CI — would otherwise block), and works in
# bypassPermissions mode where prompts for `pnpm run format` wouldn't appear.
#
# Safety: best-effort. If Biome can't parse the file (a mid-edit syntax error),
# it leaves the file alone — we silently skip rather than blocking the edit.

set -uo pipefail

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

case "$file_path" in
  *.mjs|*.cjs|*.js|*.jsx|*.ts|*.mts|*.cts|*.tsx|*.json|*.jsonc) ;;
  *) exit 0 ;;
esac
[ -f "$file_path" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

if [ -x node_modules/.bin/biome ]; then
  node_modules/.bin/biome format --write "$file_path" >/dev/null 2>&1 || true
else
  pnpm exec biome format --write "$file_path" >/dev/null 2>&1 || true
fi

exit 0
