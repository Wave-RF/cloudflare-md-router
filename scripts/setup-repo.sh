#!/usr/bin/env bash
# One-time (idempotent) repo hardening — run AFTER this PR merges and CI has run
# at least once on `main` (so the check names below already exist; GitHub only
# lets you require a status check it has seen). Requires `gh` authenticated with
# admin on the repo. Safe to re-run.
#
#   bash scripts/setup-repo.sh
#
# What it sets:
#   - Merge method: squash only, squash subject = PR title (what release-please
#     parses), delete head branch on merge.
#   - Branch protection on `main`: require a PR (0 approvals — solo-friendly),
#     require the `ci` + `pr-title` status checks, dismiss stale reviews, require
#     conversation resolution, BLOCK force-pushes and deletions. enforce_admins
#     stays OFF so you keep a bootstrap escape hatch — flip it on later once the
#     flow is proven (see RELEASING.md).
set -euo pipefail

repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "Configuring ${repo} …"

# ── Merge method + branch hygiene ───────────────────────────────────────────
gh api -X PATCH "repos/${repo}" \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F squash_merge_commit_title=PR_TITLE \
  -F squash_merge_commit_message=PR_BODY \
  -F delete_branch_on_merge=true \
  -F allow_auto_merge=true \
  >/dev/null
echo "  ✓ squash-only merges, PR title as commit subject, auto-delete + auto-merge enabled"

# ── Branch protection on main ───────────────────────────────────────────────
# required_pull_request_reviews present (even at 0 approvals) forces changes
# through a PR; required_status_checks ties the merge to green CI + a valid title.
gh api -X PUT "repos/${repo}/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - >/dev/null <<'JSON'
{
  "required_status_checks": { "strict": false, "contexts": ["ci", "pr-title"] },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "required_linear_history": false
}
JSON
echo "  ✓ main protected: PR required, checks [ci, pr-title], no force-push, no deletion"
echo "Done. Re-run any time; flip enforce_admins on in RELEASING.md once stable."
