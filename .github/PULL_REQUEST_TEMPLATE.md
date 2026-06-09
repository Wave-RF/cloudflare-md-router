<!--
PR title MUST be Conventional Commits (the required `pr-title` check, and the
squash-merge subject release-please parses for the version bump):
  <type>(optional-scope)(optional-!): <lowercase subject, no trailing period>   (<= 72 chars)
  types: feat fix docs refactor test chore ci deps build perf revert style
  breaking change: add `!` (e.g. `feat!: …`) or a `BREAKING CHANGE:` body footer.
-->

## Summary

<!-- What changed and why. -->

## Test plan

<!-- How you verified it. `pnpm run verify` (Biome + tsc --noEmit) at minimum. -->

## Checklist

- [ ] `pnpm run verify` passes locally (Biome + `tsc --noEmit`)
- [ ] Public surface changes (`MdRouterOptions` options, exports like `createMdRouter`/`mdRouter`/`LLM_BOT_UA`) are reflected in the `src/` JSDoc **and** `README.md`
- [ ] Changed routing invariants (the pass-through rules, the `.md`-twin/HTML-fallback behavior, the `Link`-header advertisement, the bot list) are noted in `README.md`
- [ ] Changes preserve the documented `wrangler.jsonc` contract (the `ASSETS` binding + `run_worker_first`)
