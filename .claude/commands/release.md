---
description: Show what the next merge to main would release (version and notes), or why it would release nothing. Releases are automatic on merge via semantic-release; this is a read-only helper, not a manual bump.
argument-hint: "(no args) - summarize unreleased commits and the version they imply"
---

Releases are **automatic on merge to `main`** (`.github/workflows/publish-npm.yml` runs semantic-release, config in `.releaserc.json`). There is no release PR to merge. Whether a merge releases is decided by its Conventional-Commit title: `fix`/`perf`/`revert` -> patch, `feat` -> minor, `!`/`BREAKING CHANGE` -> major, everything else (`deps ci chore docs test refactor build style`) -> no release. The git tag `vX.Y.Z` is the version; `package.json` `version` is the placeholder `0.0.0-development`.

## What to do

1. **Show what is published and tagged:**
   ```bash
   npm view @wave-rf/cloudflare-md-router dist-tags
   git fetch --tags -q && git describe --tags --abbrev=0 origin/main
   gh release list --limit 5
   ```
2. **Show what has landed since the last release** and say what it implies:
   ```bash
   git log --format='%h %s' "$(git describe --tags --abbrev=0 origin/main)..origin/main"
   ```
   Apply the title table above: the highest-ranked type wins. If nothing in the list is `feat`/`fix`/`perf`/`revert`/`!`, the next merge-driven run releases nothing - that is normal.
3. **Check the last release run:** `gh run list --workflow publish-npm.yml --limit 3`. A failed run also opens a "release failed" issue; re-run it with `gh run rerun <id>` once the cause is fixed.

## Special cases

- **Ship a dependency bump:** retitle the Dependabot PR `fix(deps): ...` before merging (a `deps:` title never releases).
- **Force a release with no code change:** merge a `fix:` PR (e.g. a doc-comment correction). There is no `Release-As:` footer in this setup.
- **Verify a published release:** `npm view @wave-rf/cloudflare-md-router@<version>` (provenance shows on the npm page); `gh release view v<version>`.

You (the agent) never tag, publish, bump `version` or edit `CHANGELOG.md` by hand - a hand-made tag desyncs the version history. Fix the PR title instead.
