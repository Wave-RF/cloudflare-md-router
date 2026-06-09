# cloudflare-md-router

A tiny Cloudflare Worker that serves the `.md` twin of any static page when the request is from a known LLM crawler or explicitly asks for `text/markdown`. Falls back to the HTML response when the `.md` twin doesn't exist.

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

The included bot list covers the common ones: GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, Claude-Web, anthropic-ai, PerplexityBot, CCBot, Applebot-Extended, Google-Extended, cohere-ai, Bytespider, Diffbot. See `src/bots.ts`.

## Install

```sh
pnpm add github:Wave-RF/cloudflare-md-router
# or pin to a tag / commit:
# pnpm add github:Wave-RF/cloudflare-md-router#v0.1.0
```

## Use

The simplest setup — re-export the default handler from your worker entrypoint:

```ts
// worker/index.ts
export { default } from "cloudflare-md-router/worker";
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
import { createMdRouter, LLM_BOT_UA } from "cloudflare-md-router";

export default createMdRouter({
  // Add your own bots:
  botUserAgents: new RegExp(LLM_BOT_UA.source + "|mybot", "i"),

  // Treat `Accept: text/x-markdown` as markdown too:
  acceptMarkdown: ["text/x-markdown"],

  // Custom .md path strategy. Default: `/foo/` → `/foo.md`, `/` → `/index.md`.
  mdPathFor: (pathname) => `/markdown${pathname.replace(/\/$/, "")}.md`,

  // Don't advertise the `.md` twin via a `Link` header (default: true).
  advertiseTwin: false,
});
```

## Why content-negotiate?

Most LLMs do better with raw markdown than with rendered HTML — less DOM noise, no Starlight nav chrome, no script tags. Serving the same content at one URL with two representations means:

- One canonical URL per page (good for citations and link-sharing).
- Crawlers and human readers stay aligned automatically.
- Your `llms.txt` can advertise `<page>.md` for explicit fetches; the worker covers the case where the LLM hits the HTML URL anyway.

## License

MIT — see [LICENSE](./LICENSE).
