---
description: Inspect and explain the pending release — what release-please will cut and how to ship it. Releases are automated from Conventional Commits; this is a read-and-guide helper, not a manual bump.
argument-hint: "(no args) — summarize the pending release PR and the publish flow"
---

Releases are **automated by release-please** (`.github/workflows/publish-npm.yml`). You almost never bump a version by hand. The flow:

1. PRs land on `main` with Conventional-Commit titles (squash-merge → the title is the commit release-please parses).
2. release-please keeps an open **release PR** that bumps `version` in `package.json`, updates `CHANGELOG.md`, and updates `.release-please-manifest.json`. Its version is derived from the commits since the last release: during 0.x, **breaking (`feat!`/`BREAKING CHANGE`) → minor**, **`feat`/`fix` → patch** (see `release-please-config.json`).
3. **Merging that release PR** is what ships: release-please tags `vX.Y.Z` + creates the GitHub Release, and the same workflow run then publishes to npm (`latest`, or `alpha`/`beta`/`rc`/`next` for a prerelease version) with provenance via OIDC.
4. Independently, **every push to `main`** publishes a content-addressed `0.0.0-dev.<hash>` under the **`dev`** dist-tag — bleeding-edge, never the `latest` consumers get.

So "do a release" = **merge the release PR**. This command surfaces what's pending so you can decide.

## What to do

1. **Show what's published now:**
   ```bash
   npm view @wave-rf/cloudflare-md-router dist-tags 2>/dev/null || echo "not yet published — see RELEASING.md for the one-time bootstrap"
   ```
2. **Find the pending release PR** (release-please labels it `autorelease: pending`):
   ```bash
   gh pr list --state open --label "autorelease: pending" --json number,title,url,headRefName
   ```
   - **If there is one**, summarize it for the user: the version it will cut (from the title, e.g. `chore(main): release 0.3.0`), and the `CHANGELOG.md` it proposes:
     ```bash
     gh pr diff <num> -- CHANGELOG.md
     ```
     Then tell the user plainly: *merging this PR (squash) publishes `<version>` to npm `@latest` + creates the GitHub Release.* **You (the agent) must not merge it** — `gh pr merge` is denied and releasing is a human-gated action. The user merges it in the GitHub UI or with `gh pr merge <num> --squash`.
   - **If there is none**, say so and explain why: either no releasable commits have landed since the last release (only `chore`/`docs`/`ci`/`test`/`refactor` since then — none bump the version), or release-please hasn't run yet (it runs on push to `main`). Show recent history so the user can see what's accumulated:
     ```bash
     git log --oneline "$(git describe --tags --abbrev=0 2>/dev/null)..origin/main" 2>/dev/null || git log --oneline -20 origin/main
     ```

## Special cases

- **Force a specific version** (e.g. graduate to 1.0.0): land a commit whose body contains `Release-As: 1.0.0`. release-please will propose exactly that on the next run.
- **Cut a prerelease**: a version like `0.3.0-rc.1` publishes under the matching dist-tag (`rc`) and is marked a GitHub pre-release; consumers on `^0.2.0` never receive it.
- **Verify a published release**: `npm view @wave-rf/cloudflare-md-router@<version>` (provenance shows on the npm page); `gh release view v<version>`.

Don't hand-edit `CHANGELOG.md`, `package.json` `version`, or `.release-please-manifest.json` — release-please owns all three, and a manual edit desyncs its state. If a release looks wrong, fix the commit messages / config, not the generated files.
