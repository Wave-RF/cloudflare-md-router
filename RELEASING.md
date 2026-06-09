# Releasing & maintenance

How `@wave-rf/cloudflare-md-router` is published, and the **one-time bootstrap** to enable it.

## The model

- **Versioning is automated** by [release-please](https://github.com/googleapis/release-please) from Conventional-Commit messages. You don't bump versions or create tags by hand.
- **Auth is OIDC trusted publishing** — no `NPM_TOKEN` secret in the repo. Publishes are short-lived-token + provenance-attested, from `.github/workflows/publish-npm.yml`.
- **Two npm channels:** `latest` (+ `alpha`/`beta`/`rc`/`next` for prereleases) from tagged releases, and `dev` (a content-addressed `0.0.0-dev.<hash>` on every push to `main`).
- During **0.x**: breaking (`feat!`/`BREAKING CHANGE`) → **minor**, `feat`/`fix` → **patch** (`release-please-config.json`), so `^0.x` consumers auto-get features+fixes and are shielded from breaking changes.
- **No build step.** The package ships raw TypeScript (`src/`); `npm publish` packs the `files` allowlist directly. Consumers bundle the `.ts` with Wrangler/esbuild.

## One-time bootstrap (do once, in order)

> **Why the first publish is manual:** npm OIDC trusted publishing can't *create* a package that doesn't exist yet — the trusted-publisher config attaches to an existing package. So the very first publish is a manual `npm publish`; CI/OIDC takes over from the next release.

**1. npm org.** Make sure the **`@wave-rf`** org exists on npmjs.com and your account can publish to it. (This package was previously distributed via `github:Wave-RF/cloudflare-md-router`; npm is the new home, and the package is being renamed from the unscoped `cloudflare-md-router` to the scoped `@wave-rf/cloudflare-md-router`.)

**2. First manual publish** (creates the package). From a checkout of this branch (or `main` after merge), logged in as a `@wave-rf` member:

```sh
npm login
npm pack --dry-run        # sanity: should list ONLY the src/ files (src/index.ts, src/worker.ts, src/bots.ts), README.md, LICENSE, package.json
npm publish --access public
```

`publishConfig.access` is already `public` in `package.json`, so `--access public` is belt-and-suspenders. This publishes `0.2.0` to the `latest` tag.

> This manual `0.2.0` won't carry a provenance attestation (provenance can only be generated from CI/OIDC — a laptop publish errors with "provider: null" if you force it). That's expected and fine for the one-time bootstrap; every CI publish from the next release on (and the `@dev` builds) is provenance-attested via the `--provenance` flag in `publish-npm.yml`.

**3. Configure the trusted publisher.** On npmjs.com → the package → **Settings → Trusted Publisher** → add a **GitHub Actions** publisher with **exactly**:

| Field | Value |
| ----- | ----- |
| Organization / owner | `Wave-RF` |
| Repository | `cloudflare-md-router` |
| Workflow filename | `publish-npm.yml` |
| Environment | *(leave blank — the jobs declare no `environment:`)* |

The workflow filename is matched literally — if you ever rename `publish-npm.yml`, update this or publishing breaks. (Optional hardening: once OIDC works, enable "Require 2FA and disallow tokens" so CI is the only publish path.)

**4. No extra token needed.** release-please uses the built-in `GITHUB_TOKEN`. One consequence: a PR opened by `GITHUB_TOKEN` **doesn't trigger CI**, so the **release PR's** `ci`/`pr-title` checks won't run on their own. Because `scripts/setup-repo.sh` leaves `enforce_admins` **off**, you merge the release PR with the admin **"Merge without waiting for requirements to be met"** button — one extra click per release. (Human and Dependabot PRs run CI normally; only the bot-opened release PR needs the override.) *Optional upgrade later:* a fine-grained PAT in the secret `RELEASE_PLEASE_TOKEN` (Contents + Pull requests: write) would let the release PR run CI automatically — but it's not required.

**5. Branch protection + merge settings.** After this PR is merged **and CI has run once on `main`** (so the check names `ci` and `pr-title` exist), run:

```sh
bash scripts/setup-repo.sh
```

This sets squash-only merges (PR title as the commit subject), auto-merge + auto-delete, and protects `main`: PR required (0 approvals — solo-friendly), required checks `ci` + `pr-title`, **no force-push, no deletion**, dismiss-stale-reviews, conversation resolution. `enforce_admins` is left **off** so you keep a bootstrap escape hatch — flip it on later with:

```sh
gh api -X PUT repos/Wave-RF/cloudflare-md-router/branches/main/protection/enforce_admins
```

## Cutting a release (ongoing — the normal path)

1. Land Conventional-Commit PRs on `main` (squash-merge).
2. release-please keeps an open **release PR** (`chore(main): release X.Y.Z`) with the version bump + `CHANGELOG.md`. Inspect it any time with **`/release`** or `gh pr list --label "autorelease: pending"`.
3. **Merge the release PR.** That tags `vX.Y.Z`, creates the GitHub Release, and the same workflow run publishes to npm with provenance.

Every push to `main` also publishes a `0.0.0-dev.<hash>` to the `dev` tag for bleeding-edge consumers (`pnpm add @wave-rf/cloudflare-md-router@dev`). It never moves `latest`.

### Prereleases & forcing a version

- A version like `0.3.0-rc.1` publishes under the matching dist-tag (`rc`) and is marked a GitHub pre-release; `^0.2.0` consumers never receive it.
- To force a specific version (e.g. graduate to `1.0.0`): land a commit whose **body** contains `Release-As: 1.0.0`.

## Verifying a release

```sh
npm dist-tag ls @wave-rf/cloudflare-md-router      # latest + dev pointers
npm view @wave-rf/cloudflare-md-router@<version>   # provenance shows on the npm page
gh release view v<version>
```

## Troubleshooting

- **`publish-release` never ran after merging the release PR** — check the `release-please` job's `releases_created` output; if release-please used `GITHUB_TOKEN` (no PAT) the release may not have been created cleanly. Confirm the tag/Release exist.
- **OIDC publish failed (`401`/`403`)** — the trusted-publisher config doesn't match: verify org/repo and that the **workflow filename** is exactly `publish-npm.yml`. The job must have `permissions: id-token: write` (it does).
- **`publish-dev` skipped with "not on npm yet"** — the one-time manual publish (step 2) hasn't happened; do it, then the next `main` push publishes `@dev`.
- **Release PR sits with no checks / can't merge** — expected without a PAT (step 4): the bot-opened PR doesn't trigger CI. Merge it with the admin "Merge without waiting for requirements to be met" button (`enforce_admins` is off). Or add the optional `RELEASE_PLEASE_TOKEN` PAT to make CI run on it.
