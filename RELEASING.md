# Releasing & maintenance

How `@wave-rf/cloudflare-md-router` is published. **Releases happen on merge to `main`**, driven by [semantic-release](https://semantic-release.org); there is no release PR and nothing to click.

## The model

- **Every squash-merge to `main` either releases or doesn't, decided by its Conventional-Commit title.** Squash merges use the PR title as the commit subject, and the required `pr-title` check validates it, so the title is the release decision.
- **The git tag is the version.** `vX.Y.Z` tags are created by the release run; `package.json` `version` stays at the placeholder `0.0.0-development` and semantic-release sets the real version in the CI workspace only. Nothing is committed back to `main` (it is protected), so there is no changelog commit.
- **GitHub Releases replace `CHANGELOG.md`.** Notes are generated per release. `CHANGELOG.md` is frozen history up to 0.2.1.
- **Auth is OIDC trusted publishing**, no `NPM_TOKEN`. Publishes carry provenance. The GitHub side (tag, Release, comments) uses the built-in `GITHUB_TOKEN`.
- **One channel.** `main` is always the latest release. There is no `@dev` channel any more.
- **No build step.** The package ships raw TypeScript (`src/`); npm packs the `files` allowlist directly.

### What releases what

| PR / commit title | Release |
| ----------------- | ------- |
| `fix:` `perf:` `revert:` | patch (0.2.1 -> 0.2.2) |
| `feat:` | minor (0.2.1 -> 0.3.0) |
| `feat!:` / any type with `!`, or a `BREAKING CHANGE:` footer | **major** (0.2.1 -> 1.0.0) |
| `deps:` `ci:` `chore:` `docs:` `test:` `refactor:` `build:` `style:` | none |

- There is no 0.x shielding (release-please's "breaking -> minor while 0.x" is gone): the first breaking change releases `1.0.0`. Mark a break deliberately.
- A breaking marker wins over a "no release" type, so `refactor!:` releases a major.
- The workflow runs `pnpm run verify` before `semantic-release`, so a red `main` never releases.
- Commit bodies are not consulted except for `BREAKING CHANGE:`. Only the squash subject matters.

### Shipping a dependency bump

Dependabot titles are `deps:` (npm) and `ci:` (actions), which do not release. A **runtime** dependency bump that consumers should receive is the exception: before merging, retitle the PR `fix(deps): bump <pkg> to <version>` (the `pr-title` check accepts it). For this package that is rare; `devDependencies` bumps should stay `deps:`.

To force a release with no other change, merge any `fix:` PR. There is no `Release-As:` footer.

### Pre-release channels

None configured. `branches` is `["main"]` only. To add a `next`/`beta` channel later, add the branch to `.releaserc.json` and mind that it needs its own protection rules.

## What a release run does

`publish-npm.yml` (push to `main`, serialised by a `publish-npm` concurrency group, never cancelled):

1. checkout with full history and tags, pnpm install, `pnpm run verify`;
2. `semantic-release` finds the latest `vX.Y.Z` tag reachable from `main`, analyses the commits since it, and exits quietly if none are releasable;
3. otherwise it pushes the new tag, runs `npm publish` via OIDC with provenance (`@semantic-release/npm`), creates the GitHub Release with generated notes, and comments "released in vX.Y.Z" on the issues and PRs involved (`@semantic-release/github`).

Node is 24 with **no `registry-url`** on `setup-node` (it writes an `.npmrc` that breaks the OIDC exchange). semantic-release and the conventional-commits preset are pinned to exact versions in `devDependencies`, so a release never fetches an unpinned latest. The preset is coupled to `@semantic-release/release-notes-generator` through `conventional-changelog-writer`: as of notes-generator 14.x (semantic-release 25) the preset must stay on 9.x — preset 10.x fails at `generateNotes` with "requires conventional-changelog-writer@9", which only notes-generator 15 (beta) uses. So `semantic-release`, `@semantic-release/commit-analyzer`, `@semantic-release/release-notes-generator` and the preset are all exact-pinned `devDependencies`, Dependabot groups them into one `release` PR (and holds preset majors until notes-generator 15 is stable), and `pnpm run check:release` — in `verify` and CI — runs both plugins with this repo's `.releaserc.json` against synthetic commits, so an incompatible pairing fails its PR rather than a release on `main`.

### Failures and re-runs

- A failed release opens a **"The automated release is failing"** issue (from `@semantic-release/github`) with the error. That is the "release broke" signal. It closes itself on the next success.
- **Failure before the tag is pushed** (verify red, OIDC misconfigured at verify time): fix and re-run the failed workflow run. Nothing was released.
- **Failure after the tag is pushed** (e.g. `npm publish` 403/network): the tag `vX.Y.Z` already exists, so a re-run sees "no release". Delete the tag so semantic-release re-derives it, then re-run:

  ```sh
  git push --delete origin vX.Y.Z      # only if the version is NOT on npm
  gh run rerun <run-id>
  ```

  Check `npm view @wave-rf/cloudflare-md-router versions` first; never delete a tag whose version is already published.
- The workflow triggers on `push` to `main` only; re-run with `gh run rerun <run-id>` or the Actions UI "Re-run jobs". Add `workflow_dispatch:` later if manual dispatch is wanted.
- **Roll back a bad release:** `npm deprecate "@wave-rf/cloudflare-md-router@X.Y.Z" "<why>"` and ship a `fix:`. Unpublishing is restricted by npm; prefer deprecate.

### Checking what the next merge would do (dry run, no writes)

```sh
pnpm install
# From a clone whose `main` exists on its remote. Restricting plugins means
# nothing can publish; --dry-run also skips tag creation.
pnpm exec semantic-release --dry-run --no-ci \
  --plugins @semantic-release/commit-analyzer @semantic-release/release-notes-generator
```

Note the CLI `--plugins` override drops the plugin options in `.releaserc.json` (so it falls back to the default preset and rules); for an exact replay of the real rules, run the programmatic API with the config's two analysis plugins only. `/release` in Claude Code summarises the same thing from the commit list.

## One-time bootstrap (npm side)

> **Why the first publish is manual:** npm OIDC trusted publishing can't *create* a package that doesn't exist yet; the trusted-publisher config attaches to an existing package. This package is already on npm (0.2.0, 0.2.1), so this section is history for this repo and a checklist for sibling repos.

1. **npm org.** The **`@wave-rf`** org must exist and your account must be able to publish to it.
2. **First manual publish** (creates the package), from a clean checkout, logged in as a `@wave-rf` member:

   ```sh
   npm login
   npm pack --dry-run        # should list only src/, README.md, LICENSE, package.json
   npm publish --access public
   ```

   A laptop publish carries no provenance attestation (that needs CI/OIDC); expected for the bootstrap. Because `package.json` `version` is now the placeholder `0.0.0-development`, a *new* package would need a real version set by hand for this one publish (and a matching `vX.Y.Z` tag pushed so semantic-release continues from it).
3. **Configure the trusted publisher.** npmjs.com -> the package -> **Settings -> Trusted Publisher** -> **GitHub Actions**, with exactly:

   | Field | Value |
   | ----- | ----- |
   | Organization / owner | `Wave-RF` |
   | Repository | `cloudflare-md-router` |
   | Workflow filename | `publish-npm.yml` |
   | Environment | *(blank; the job declares no `environment:`)* |

   The filename is matched literally; renaming `publish-npm.yml` breaks publishing. Optional hardening: enable "Require 2FA and disallow tokens" so CI is the only publish path.
4. **No secrets.** Neither `NPM_TOKEN` nor a PAT is needed. `GITHUB_TOKEN` creates the tag and Release (the workflow grants `contents`, `issues`, `pull-requests` write and `id-token: write`). Tag pushes made with `GITHUB_TOKEN` do not trigger other workflows; nothing here depends on that.
5. **Branch protection + merge settings.** Run once CI has run on `main` (so the `ci` and `pr-title` check names exist):

   ```sh
   bash scripts/setup-repo.sh
   ```

   Squash-only merges (PR title = commit subject: this is what semantic-release reads), auto-merge, auto-delete, protected `main` (PR required, `ci` + `pr-title` required, no force-push or deletion). `main` stays protected, which is why the release never commits to it.

## Verifying a release

```sh
npm dist-tag ls @wave-rf/cloudflare-md-router      # latest -> the new version
npm view @wave-rf/cloudflare-md-router@<version>   # provenance shows on the npm page
gh release view v<version>
```

## Troubleshooting

- **A merge didn't release.** Expected if its title was `deps`/`ci`/`chore`/`docs`/`test`/`refactor`/`build`/`style`. Check the run log: "no relevant changes, so no new version is released". Retitle future PRs, or merge a `fix:`.
- **OIDC publish failed (`401`/`403`/`ENEEDAUTH`).** The trusted-publisher config doesn't match (org, repo, workflow filename `publish-npm.yml`), or `setup-node` was given `registry-url` again, or the runner's npm is older than 11.5.1.
- **"No release" right after a failed publish.** The tag already exists; see *Failure after the tag is pushed* above.
- **Release notes show the wrong range.** semantic-release uses the latest tag reachable from `main`. Don't hand-create tags.
