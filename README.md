# cloudflare-md-router

A tiny Cloudflare Worker that serves the `.md` twin of any static page when the request is from a known LLM crawler or explicitly asks for `text/markdown`. Falls back to the HTML response when the `.md` twin doesn't exist.

It also ships `cloudflare-md-router dev`, a local dev loop that serves real builds through `wrangler dev`, so the Worker's routing works while you edit (see [Dev loop](#dev-loop-cloudflare-md-router-dev)).

If you're building a docs site that already emits a per-page raw-markdown twin (e.g. `/foo/bar` and `/foo/bar.md`), this lets every page do content negotiation transparently — Claude, ChatGPT, Perplexity, etc. fetch the model-friendly version automatically; humans keep getting the styled HTML page.

## Behavior

| Request                                        | Worker serves       |
| ---------------------------------------------- | ------------------- |
| Anything with a file extension (`.css`, `.png`, `.md`, …) | Pass-through to ASSETS |
| Non-GET                                        | Pass-through to ASSETS |
| `Accept: text/markdown`                        | `<path>.md` (HTML fallback on 404) |
| `User-Agent` matches a known LLM bot           | `<path>.md` (HTML fallback on 404) |
| Everything else                                | HTML page — plus a `Link` header advertising its `.md` twin |

On the normal HTML page response, the worker also adds an [RFC 8288](https://www.rfc-editor.org/rfc/rfc8288) `Link` header so an agent can discover the markdown twin from a plain GET, without sniffing the User-Agent or guessing the right `Accept`:

```http
Link: </foo/bar.md>; rel="alternate"; type="text/markdown"
```

This is on by default (only for a `200 text/html` reply to an extension-less GET); disable it with `advertiseTwin: false`.

Because the worker negotiates on the `Accept` header, two clients can get different representations of the same URL. If you put a shared cache (a CDN, Cloudflare's own cache) in front of it, set `vary: true` to add a `Vary: Accept` header to the negotiated responses so the cache keys on `Accept` and doesn't serve the HTML page to a client that asked for markdown — or vice-versa. It's off by default (verbatim pass-through stays byte-for-byte; `Vary: User-Agent` is intentionally not added, as it would defeat shared caching).

The included bot list covers the common ones: GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, Claude-Web, anthropic-ai, PerplexityBot, CCBot, Applebot-Extended, Google-Extended, cohere-ai, Bytespider, Diffbot. See `src/bots.ts`.

## Install

```sh
pnpm add @wave-rf/cloudflare-md-router
```

This package ships raw TypeScript with no build step — bundle it with Wrangler/esbuild (the Cloudflare Workers default), which resolve the `.ts` entry points directly.

## Use

The simplest setup — re-export the default handler from your worker entrypoint:

```ts
// worker/index.ts
export { default } from "@wave-rf/cloudflare-md-router/worker";
```

Configure your `wrangler.jsonc` with an ASSETS binding pointing at your built static site:

```jsonc
{
  "name": "my-docs",
  "main": "worker/index.ts",
  "compatibility_date": "2025-01-01",
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "404-page",
    "html_handling": "drop-trailing-slash",
    "run_worker_first": true
  }
}
```

`run_worker_first` is required so the worker sees the request before Cloudflare's static-asset matcher does — otherwise the worker only ever runs on 404s.

## Customizing

Use `createMdRouter()` if you need to extend the bot list, change the `.md` path mapping, or add other Accept tokens:

```ts
// worker/index.ts
import { createMdRouter, LLM_BOT_UA } from "@wave-rf/cloudflare-md-router";

export default createMdRouter({
  // Add your own bots:
  botUserAgents: new RegExp(LLM_BOT_UA.source + "|mybot", "i"),

  // Treat `Accept: text/x-markdown` as markdown too:
  acceptMarkdown: ["text/x-markdown"],

  // Custom .md path strategy. Default: `/foo/` → `/foo.md`, `/` → `/index.md`.
  mdPathFor: (pathname) => `/markdown${pathname.replace(/\/$/, "")}.md`,

  // Don't advertise the `.md` twin via a `Link` header (default: true).
  advertiseTwin: false,

  // Add `Vary: Accept` to negotiated responses so a shared cache doesn't
  // cross-serve the HTML and markdown representations (default: false).
  vary: true,
});
```

## Dev loop (`cloudflare-md-router dev`)

`astro dev` (or any framework dev server) skips everything the Worker adds in production: the `.md` twins, the `Link` header, and any outputs that only exist in a real build. If your Worker serves something the dev server can't, use this instead of it. If the Worker adds nothing you are iterating on, keep using the dev server — it has HMR and an error overlay; this does not.

The command runs a **full build on every save** into a staging directory, copies it into your output directory **only if the build succeeded**, and serves that directory through `wrangler dev --live-reload`. A failed build (or the emptied-output window during one) never reaches the browser: you keep the last good build, with a red banner and a terminal bell. Ctrl-C stops the build (its whole process tree) and wrangler, with SIGTERM and then SIGKILL after 5 s, and the command does not exit until they are gone. Each save costs a real build, with errors in the terminal rather than the page.

```sh
pnpm add -D @wave-rf/cloudflare-md-router wrangler
pnpm exec cloudflare-md-router dev
```

```jsonc
// package.json
{ "scripts": { "dev:worker": "cloudflare-md-router dev" } }
```

Needs Node 20+ (recursive `fs.watch`; checked at startup, tested in CI on Node 24 only; POSIX is the supported platform, Windows is best-effort) and a locally-installed `wrangler`. It is never downloaded: the site's own `wrangler` package is resolved the way `require` would (so a workspace-root install works) and its `bin` is run directly with Node, with no package manager or shell in between to swallow Ctrl-C. If the package can't be resolved (Yarn PnP, or not installed) it falls back to your package manager's local exec (`pnpm exec`, `npm exec --no`, `yarn`, `bun x --no-install`). That fallback is best-effort on shutdown: on Linux, npm and pnpm run it through `sh`, which does not pass signals on, so the CLI also signals wrangler's descendants directly. Add the staging directory (`.dev-<outDir>`, so `.dev-dist/` by default) to `.gitignore`.

| Option | Default |
| ------ | ------- |
| `--build <cmd>` (`MD_ROUTER_DEV_BUILD`) | the site's `build` script, via the package manager its lockfile indicates (pnpm, yarn, bun or npm; the lockfile is searched up the tree, so monorepos work), else the `packageManager` field in `package.json`, else npm. A custom command runs through the shell with `node_modules/.bin` on `PATH`, so `--build "astro build"` works. |
| `--out-dir <dir>` | `assets.directory` from `wrangler.jsonc` / `wrangler.json` / `wrangler.toml` (JSONC comments and trailing commas are fine), else `dist`. The staging directory is `.dev-<name>` next to it. Both are emptied and refilled on every build, so the command refuses (and says why) any directory that could hold something else: the site root or anything above it; `src/`, `public/`, `node_modules/`, `.git/` or the Worker's directory (from wrangler `main`), whether equal, inside or enclosing; the wrangler config's directory; one with a `package.json`; and one holding git-tracked files. Paths are compared as the filesystem resolves them, so `SRC` on a case-insensitive disk is `src`. A Worker that the wrangler config itself places inside `assets.directory` (Astro's `dist/_worker.js`) is treated as build output. |
| `--out-dir-flag <flag>` | `--outDir`: appended to the build as `<flag> <staging>` so it writes to staging, not the served directory. Pass `""` to disable. Put `{outDir}` anywhere in `--build` to place the path yourself (and skip the flag). The staging path (relative to the site root) is also exported as `MD_ROUTER_DEV_OUT_DIR`; a relative `--out-dir` resolves against the wrangler config's directory. |
| `--watch <path>` | Added to the defaults: `src/`, `public/`, `astro.config.*`, `vite.config.*`, `tsconfig.json`, `package.json`, `.env*`. Directories recurse; other entries are root-level file names (a trailing `*` matches a prefix). Repeatable or comma-separated. `--no-default-watch` drops the defaults. The Worker directory is deliberately not watched — wrangler reloads the Worker itself. Changes under the output and staging directories, `node_modules/`, `.git/` and `.wrangler/` never trigger a build, so `--watch .` is safe. |
| `--port <n>` (`PORT`) | `4321`. If it is taken, the next free port (up to 19 higher, both IPv4 and IPv6 loopback checked) is used and printed — wrangler itself would just die on a busy explicit port. |
| `--config <file>` | `wrangler.jsonc`, `wrangler.json`, then `wrangler.toml` in the root. A `--config` that doesn't exist is an error. |
| `--root <dir>` | the current directory. |
| `--strict` (`MD_ROUTER_DEV_STRICT=1`) | off. See below. |
| `-- <args>` | everything after `--` is passed to `wrangler dev`. |
| `--help`, `-h` | prints the options and exits. |

Flags win over env. A failed build, and a build that exits 0 but writes nothing, are both handled: the previous good build stays up. A build that ignores the staging directory and writes straight into the output directory (say `astro build && node postbuild.mjs` without `{outDir}`) is called out as such: what is served is whatever it left there, with no last-good-build protection, until you point it at `{outDir}` or set `--out-dir-flag`. On a cold start with no output directory yet, the first build must succeed or the command exits 1. When wrangler exits, so does the command, with wrangler's exit code (1 if wrangler was killed by a signal); a Ctrl-C you send exits 0.

### Relaxing checks in watch builds

Every build in the loop runs with `MD_ROUTER_DEV=1` (unless `--strict`). Use it in your site config to turn off checks that are right for CI but wrong mid-edit — typically a link validator, since a page you are still writing links to pages that don't exist yet. The rendered output should be identical; only the gate differs:

```js
// astro.config.mjs
const watchBuild = Boolean(process.env.MD_ROUTER_DEV);

export default defineConfig({
  integrations: [
    // Fails the build on a broken link: keep it for CI and `astro build`, skip it in the dev loop.
    ...(watchBuild ? [] : [starlightLinksValidator({ errorOnRelativeLinks: true })]),
  ],
});
```

Run `cloudflare-md-router dev --strict` (or `MD_ROUTER_DEV_STRICT=1`) to leave the variable unset and get the CI behaviour in the loop.

## Why content-negotiate?

Most LLMs do better with raw markdown than with rendered HTML — less DOM noise, no Starlight nav chrome, no script tags. Serving the same content at one URL with two representations means:

- One canonical URL per page (good for citations and link-sharing).
- Crawlers and human readers stay aligned automatically.
- Your `llms.txt` can advertise `<page>.md` for explicit fetches; the worker covers the case where the LLM hits the HTML URL anyway.

## License

MIT — see [LICENSE](./LICENSE).
