# Contributing

Thanks for contributing to `@wave-rf/cloudflare-md-router`.

## Setup

```sh
pnpm install      # resolve deps (there's no committed lockfile — it's a library)
pnpm run setup    # one-time: install the git hooks (pre-commit + pre-push)
```

The package is pure ESM and ships **raw TypeScript** with no build step — `src/index.ts`, `src/worker.ts`, and `src/bots.ts` are what publish (consumers bundle the `.ts` with Wrangler/esbuild). It runs on the Cloudflare Workers runtime, not Node; `engines.node` (`>=18`) documents the consumer toolchain floor.

## Develop

```sh
pnpm run typecheck   # tsc --noEmit (strict)
pnpm run check       # Biome lint + format check (what CI runs)
pnpm run format      # auto-fix formatting
pnpm run verify      # check + typecheck together (the local gate; what the hooks run)
```

Biome owns JS/TS/JSON style. There is **no test runner** today — CI is Biome + `tsc --noEmit`. If you add non-trivial routing logic, a test (a stub `ASSETS` Fetcher driving `createMdRouter()`) is encouraged. See [AGENTS.md §Key Invariants](AGENTS.md#key-invariants) for what must stay true (the verbatim pass-through, the markdown-routing trigger, the HTML-fallback-on-404, the opt-in `Link` header, the `wrangler.jsonc` contract).

## Pull requests

- **Title must be [Conventional Commits](https://www.conventionalcommits.org/):** `<type>(scope): subject`, ≤ 72 chars, lowercase subject, no trailing period. Types: `feat fix docs refactor test chore ci deps build perf revert style`. A breaking change uses `feat!:` (or a `BREAKING CHANGE:` body footer). The title becomes the squash-merge commit and **drives the version bump** — check it with `scripts/lint-pr-title.sh "<title>"`.
- Run `pnpm run verify` before pushing; the pre-push hook requires it.
- Update the `src/` JSDoc + `README.md` when you change the public surface — `MdRouterOptions` options, the exports, a default, the `LLM_BOT_UA` bot list, or the `wrangler.jsonc` contract (see [AGENTS.md §Documentation Sync](AGENTS.md#documentation-sync)). **Don't** hand-edit `CHANGELOG.md` — it's generated from commit messages.
- PRs merge via **squash**; required checks (`ci`, `pr-title`) must pass.

## Releases

Automated — you don't bump versions or tag by hand. Merges to `main` accumulate into a release PR (maintained by release-please); merging that PR publishes to npm. During 0.x, breaking changes bump the minor and features/fixes bump the patch, so `^0.x` consumers auto-update safely. Maintainers: see [RELEASING.md](RELEASING.md).
