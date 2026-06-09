# AGENTS.md — AI agent instructions for `@wave-rf/cloudflare-md-router`

Context for AI coding agents (Claude Code, Copilot, Cursor, etc.) working on this repo. `CLAUDE.md` is a thin pointer here.

## Operating Rules

The non-negotiables, ordered by how often agents miss them. These override convenience: if a rule blocks you, satisfy it; don't work around it.

1. **Validate locally before every push** — `pnpm run verify` (Biome + `tsc --noEmit`). Don't use CI as your first feedback loop ([§Local-First Validation](#local-first-validation)).
2. **A PR-branch push needs every pre-push reviewer satisfied** — run **`/prepush`**: it reads `scripts/pre-push-reviewers.sh`, runs the reviewers the change needs in parallel (fresh context), skips the rest *on the record*, and loops until each it ran returns `ship_it` ([§Agent PR Discipline](#agent-pr-discipline)).
3. **Every public-surface change updates its docs in the same PR** — a changed `MdRouterOptions` option / export / default / the `LLM_BOT_UA` bot list / the `wrangler.jsonc` contract must update the **`src/` JSDoc** **and** `README.md` ([§Documentation Sync](#documentation-sync)). The `CHANGELOG.md` is **auto-generated** — don't hand-edit it; just use the right Conventional-Commit type.
4. **Address and resolve every review finding** — fix it or track it in an issue; never silently drop one ([§Review Response](#review-response)).
5. **Drafts only; valid title** — `gh pr create --draft` (never `gh pr ready`/approve); the PR **title** must pass Conventional Commits — check with `scripts/lint-pr-title.sh "<title>"` before creating ([§Agent PR Discipline](#agent-pr-discipline)).
6. **Never force-push or rebase a PR branch** — to absorb upstream, `git merge origin/main` ([§Branch Maintenance](#branch-maintenance)).
7. **Never hand-write markers or `--no-verify`** — if you're tempted, the gate is wrong-shaped for your situation; fix that instead ([§Don't bypass the gates](#dont-bypass-the-gates)).

## Project Overview

A tiny, **pure-ESM** Cloudflare Worker for **request-time content negotiation** on a static site. When a request looks like an LLM fetcher — a known crawler `User-Agent` (`LLM_BOT_UA`) or an explicit `Accept: text/markdown` — it serves the page's **`.md` twin** (e.g. `/foo/bar/` → `/foo/bar.md`) from the `ASSETS` static-assets binding, falling back to the original HTML response if the twin 404s. For "normal" requests it returns the HTML page and, by default, annotates it with an RFC 8288 `Link` header advertising the `.md` twin so an agent can discover it from a plain GET.

There is **no build step**: the package ships **raw TypeScript** — `src/index.ts` (the public re-export barrel), `src/worker.ts` (the whole implementation), and `src/bots.ts` (the crawler regex). Consumers bundle the `.ts` with Wrangler/esbuild (`exports` point straight at the `.ts` files; `tsconfig` uses `allowImportingTsExtensions` + `verbatimModuleSyntax`). The code runs on the **Workers runtime**, not Node — no Node built-ins.

`createMdRouter(options)` returns a Workers `ExportedHandler`; `mdRouter` (and the default export) is the zero-config instance. `LLM_BOT_UA` is the default crawler regex, exported so consumers can compose their own.

## Key Invariants

What must stay true. Preserve the named invariant when you touch its code. The repo has **no automated test suite** yet (CI is `biome check` + `tsc --noEmit`), so these invariants are guarded by review, not by tests — if you add non-trivial routing logic, adding a test (a stub `ASSETS` Fetcher) is encouraged.

1. **Pass-through is verbatim.** Non-GET requests, any pathname matching the file-extension guard (`/\.[a-zA-Z0-9]+$/`), and "normal" requests that don't want markdown are forwarded to `env.ASSETS.fetch(request)` unchanged. The worker must never alter a pass-through **body**, and apart from the opt-in `Link` header it must not alter status or other headers.
2. **Markdown-routing trigger** = `acceptTokens.some(tok => accept.includes(tok)) || botUserAgents.test(ua)`, where `acceptTokens` **always** contains `"text/markdown"` (consumer tokens via `acceptMarkdown` are *added*, never replace it) and `botUserAgents` defaults to the **case-insensitive** `LLM_BOT_UA`. Don't drop the always-on `text/markdown`, make the UA match case-sensitive, or over-match.
3. **HTML fallback on a missing twin.** When markdown is wanted, fetch `mdPathFor(pathname)`; on **404** fall back to `env.ASSETS.fetch(request)` (the *original* request) — never surface the 404, never loop, never re-fetch the `.md` path. A non-404 error response is returned as-is (it is not "missing").
4. **The `Link` header is opt-in and narrowly scoped.** Appended **only** when `advertiseTwin` (default `true`) AND `response.status === 200` AND the `Content-Type`'s first media-type token (lowercased, `;`-params stripped) is exactly `text/html`. It is added via `new Response(response.body, response)` (an asset response's headers are immutable) and its value percent-encodes **each path segment** of `mdPathFor(pathname)` then wraps it `<…>; rel="alternate"; type="text/markdown"`. The per-segment `encodeURIComponent` is the guard against header injection / a malformed `Link` — don't weaken it, and don't add the header to the `.md` or pass-through responses.
5. **`mdPathFor` default contract** — strip a trailing slash and append `.md`; the special case `/` → `/index.md`. A custom `mdPathFor` is consumer-supplied; the result is resolved against the request origin.
6. **The `ASSETS` Fetcher binding + `run_worker_first`** — the worker needs an `ASSETS` binding (`MdRouterEnv.ASSETS: Fetcher`) and, in the consumer's `wrangler.jsonc`, `run_worker_first: true` so the worker sees the request before Cloudflare's static-asset matcher (otherwise it only runs on 404s). This is a documented contract — preserve it in code and docs.
7. **Bounded fetches** — at most the two `ASSETS.fetch` calls the current flow makes (the twin, then the HTML fallback). No recursive or unbounded fetching. The UA regex runs on attacker-controlled input, so keep it **linear** (no catastrophic backtracking / ReDoS).
8. **ESM + raw-TS shipping, Workers runtime** — `type: module`; ships `.ts` with `.ts` import specifiers; no CommonJS, no build step, no Node-only APIs. `engines.node` (`>=18`) documents the consumer-tooling floor, not the runtime.

## Build & Test Commands

```bash
pnpm install            # resolve deps (no committed lockfile — it's a library)
pnpm run setup          # one-time: install git hooks (git config core.hooksPath .githooks)
pnpm run typecheck      # tsc --noEmit (strict)
pnpm run check          # biome check . (lint + format check) — the CI gate
pnpm run format         # biome format --write . (auto-fix formatting)
pnpm run lint           # biome lint .
pnpm run verify         # biome check . && pnpm run typecheck, then write the tree marker
```

There is **no test runner** — CI is Biome + `tsc --noEmit`. Biome owns JS/TS/JSON formatting + lint. Run `pnpm run format` to fix formatting; the Claude format-on-save hook keeps edited files clean automatically.

## Local-First Validation

**Validate locally before pushing.** `pnpm run verify` runs the same gates as CI (Biome + `tsc --noEmit`). On success it writes the tree-keyed marker `tmp/verify-passed-tree-<TREE>` (`tmp/` is gitignored).

Enforced via git hooks (installed by `pnpm run setup`; apply to humans and agents alike):

- **`.githooks/pre-commit`** runs `pnpm run verify` unless the current tree's marker already exists (cached).
- **`.githooks/pre-push`** requires `tmp/verify-passed-tree-<TREE>` for each pushed commit's tree. Tree-keyed, so `verify → commit → push` needs no re-run when the tree is unchanged. Skipped on CI (`$CI` set).

Bypass (`--no-verify`) is for human WIP only; agents must not (§Don't bypass the gates).

## Release Process

Releases are **automated by release-please** from Conventional Commits — you rarely touch a version by hand. The flow:

1. Land PRs with Conventional-Commit titles (squash-merge → the title is the commit release-please parses).
2. release-please maintains an open **release PR** that bumps `package.json` `version`, updates `CHANGELOG.md`, and updates `.release-please-manifest.json`. During 0.x: **breaking (`feat!`/`BREAKING CHANGE`) → minor**, **`feat`/`fix` → patch** (see `release-please-config.json`), so `^0.x` consumers safely auto-update.
3. **Merging the release PR** ships it: release-please tags `vX.Y.Z` + creates the GitHub Release, and the same `publish-npm.yml` run publishes to npm (`latest`, or `alpha`/`beta`/`rc`/`next` for a prerelease) with provenance via OIDC.
4. Independently, **every push to `main`** publishes a content-addressed `0.0.0-dev.<hash>` under the **`dev`** dist-tag (never the `latest` consumers get).

Use **`/release`** to inspect the pending release. Don't hand-edit `CHANGELOG.md` / `version` / the manifest — release-please owns them. **First-time setup** (npm org, one-time manual publish, OIDC trusted publisher, optional PAT, branch protection) lives in [`RELEASING.md`](RELEASING.md).

## Review Response

Every review finding gets a substantive reply and is addressed — fixed, or tracked in an issue — before merge. Decide: accept, push back (with reasoning), or defer (open a tracking issue and link it). Never silently drop a finding, including ones outside the lane of whichever reviewer raised it. Bot reviewers (if configured) re-engage via their own trigger (e.g. `@coderabbitai review` in a PR comment — `gh pr comment` is allowed for agents).

## Branch Maintenance

To absorb upstream `main` into a PR branch — **merge, don't rebase**:

```bash
git fetch origin main
git merge origin/main --no-edit
```

Force-pushes (`--force`, `--force-with-lease`) are blocked by `.claude/settings.json` and by branch protection, and would lose inline review-thread anchors. Rebase requires a force-push, so it's wrong for the same reason. The `pre-push` hook will block until `pnpm run verify` re-runs after the merge (the merge commit's tree is new) — that's intended. If the merge conflicts, surface it to a human rather than auto-resolving.

## Agent PR Discipline

Agents follow the universal git hooks (pre-commit + pre-push in `.githooks/`). On top of that, PR-workflow rules with no human analog are checked by `.claude/hooks/agent-bash-gate.sh`. The gate is a guard rail against accidents, not adversarial enforcement.

### Drafts only

Create PRs with `gh pr create --draft`. Only humans flip draft → ready (`gh pr ready` is blocked) and only humans approve / request changes (`gh pr review --approve`/`--request-changes` are blocked). Adding/removing human reviewers is humans-only.

**PR title format** — the title becomes the squash-merge subject on `main` (which release-please parses), and is gated by the required `pr-title` check. Conventional Commits: `<type>(optional-scope)(optional-!): <subject>`, **≤ 72 chars**, subject lowercase-first, no trailing period. Types: `feat fix docs refactor test chore ci deps build perf revert style`. Validate before creating: `scripts/lint-pr-title.sh "<title>"`. The same script backs the local gate and the CI check, so they never drift.

### Pre-push self-review is mandatory on PR branches

Before pushing a non-main branch, **every** reviewer in `scripts/pre-push-reviewers.sh` must have a marker for HEAD — earned by **running** it (fresh context; writes its marker on `VERDICT: ship_it`) or by a **logged skip** (`scripts/skip-pre-push-review.sh <name> "<reason>"`) when it's genuinely out of lane. The list is the single source of truth — read it; don't hardcode it. The one-command form is **`/prepush`**. Today the gating reviewers are:

- **`pre-push-reviewer`** (code) — the full diff vs `main`, the latest commit, open PR comments/reviews, CI status, linked issues.
- **`docs-reviewer`** (docs) — `README.md`/the `src/` JSDoc for accuracy-vs-code, runnable examples, clarity, **plus** code↔docs sync (code that changed but whose docs didn't).

**`ship_it` requires zero findings at any severity** — a single `[MAY]` forces `iterate`. The orchestrator loops: address every finding, commit, re-invoke the reviewer(s) in fresh context, until all say `ship_it`. The push gate (`agent-bash-gate.sh`) lists any missing markers; `git push` succeeds only when every listed reviewer has one. On `block`, stop and surface it to the user.

### Adding a pre-push reviewer

The set is meant to grow (security is the obvious next). With **no** hook edits (they read the list at push time):

1. Write the subagent at `.claude/agents/<name>.md` (model it on `pre-push-reviewer.md`; end with the parseable `VERDICT: ship_it|iterate|block` line under the same strict rubric).
2. Add `<name>` to `scripts/pre-push-reviewers.sh` — *after* step 1 (a name with no agent file blocks every push until it exists).

The marker `tmp/<name>-passed-<HEAD>` is then required automatically, `review-marker.sh` writes it on `ship_it`, and `/prepush` launches it alongside the rest.

### Don't bypass the gates

- `--no-verify` is for human WIP; agents don't use it.
- Markers are written by tooling, never by hand: `tmp/verify-passed-tree-*` by `pnpm run verify`; `tmp/<reviewer>-passed-*` by the `review-marker.sh` SubagentStop hook on `ship_it`, or by `scripts/skip-pre-push-review.sh` for a deliberately-skipped reviewer (which logs the reason). Don't `touch`/`Write`/`Edit` a marker. To skip, use the skip command so it's recorded.

These are policy, not mechanically enforced — an agent can edit the gate itself. Trust beats whack-a-mole.

## Documentation Sync

Every change to the public surface updates its docs in the same PR:

| Change | Files to update |
| ------ | --------------- |
| Add/modify an `MdRouterOptions` option or its default | `src/worker.ts` (the type + JSDoc), `README.md` (Customizing section + behavior table) |
| Add/modify an export or a subpath (`createMdRouter`, `mdRouter`, `LLM_BOT_UA`, `./worker`, `./bots`) | `src/index.ts`/`src/worker.ts` JSDoc, `package.json` `exports`, `README.md` (Use) |
| Change a routing invariant (pass-through rules, fallback, the `Link` header) | `README.md` (behavior table + the relevant note), the `src/` JSDoc |
| Change the `LLM_BOT_UA` bot list | `src/bots.ts`, `README.md` (the enumerated bot list) |
| Change the package name / `exports` / `engines` / peer deps / the `wrangler.jsonc` contract | `README.md` (Install + Use), `package.json` |
| Any change | a Conventional-Commit message (release-please writes `CHANGELOG.md`) |

Before finishing, grep the identifiers you touched (option names, export names, bot names) across `README.md` and `src/` to catch staleness. Prose quality + code↔docs sync are gated by the `docs-reviewer`.

## Worktree workflow (`wt`)

This repo is set up for [Worktrunk](https://github.com/) (`wt`, config in `.config/wt.toml`): `wt switch --create <branch>` seeds `node_modules/` from main (per `.worktreeinclude`), runs `pnpm install`, and installs the git hooks (`pnpm run setup`). `.worktrees/` is gitignored. `wt` is an external tool (install it separately); without it, the manual equivalent is `git worktree add` + `pnpm install` + `pnpm run setup`.

## File Structure

```text
src/index.ts            → public re-export barrel (the API entry; ships)
src/worker.ts           → the whole implementation: createMdRouter + mdRouter + the MdRouter* types (ships)
src/bots.ts             → LLM_BOT_UA, the default crawler User-Agent regex (ships)
tsconfig.json           → strict, ESNext, Bundler resolution, allowImportingTsExtensions (the typecheck gate)
scripts/                → shell + node tooling (PR-title lint, reviewer manifest, markers, dev-version, repo setup)
.githooks/              → universal pre-commit + pre-push (installed via pnpm run setup)
.claude/                → settings, review subagents, /prepush + /release commands, gate/marker/format hooks
.github/                → CI, pr-title, publish (release-please + OIDC), dependabot; prompts/ review rubrics
release-please-config.json, .release-please-manifest.json  → release automation
```

## CI / Automation

- **`ci.yml`** — Biome `check` + `tsc --noEmit` on every PR/push (Node 24; pnpm 11 needs Node ≥ 22.13, so CI doesn't run on the package's `engines` floor — that floor documents the consumer toolchain).
- **`pr-title.yml`** — Conventional-Commit title check (required); skips the check for `dependabot[bot]`.
- **`publish-npm.yml`** — release-please + OIDC publish to `latest`/prerelease, and the `@dev` content-addressed channel on every main push. ONE file (npm allows one trusted-publisher filename per package).
- **`dependabot.yml` + `dependabot-automerge.yml`** — weekly grouped dep/action bumps; patch/minor auto-merge after CI, major held for review.
- Third-party actions are pinned to commit SHAs with version comments where verified (`googleapis/release-please-action`, `dependabot/fetch-metadata` are on major tags pending a SHA pin).
