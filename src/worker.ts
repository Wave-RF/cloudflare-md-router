import { LLM_BOT_UA } from "./bots.ts";

export interface MdRouterEnv {
  ASSETS: Fetcher;
}

export interface MdRouterOptions {
  /** Override the default LLM-bot User-Agent matcher, or pass `false` to turn
   *  User-Agent routing off entirely so markdown is served only on an explicit
   *  `Accept` match (`text/markdown` plus any {@link MdRouterOptions.acceptMarkdown}
   *  tokens). With `false` the `Link` header and everything else behave as
   *  usual, so agents can still discover the twin from a plain GET. Keep a custom
   *  regex linear: it runs on attacker-controlled input. Default: {@link LLM_BOT_UA}. */
  botUserAgents?: RegExp | false;
  /** Map a request URL pathname (e.g. `/foo/bar/`) to its `.md` twin path
   *  (e.g. `/foo/bar.md`). Default strips a trailing slash and appends
   *  `.md`; the special case for `/` returns `/index.md`. */
  mdPathFor?: (pathname: string) => string;
  /** Extra Accept-header tokens that should also trigger markdown
   *  routing. `text/markdown` is always matched. */
  acceptMarkdown?: string[];
  /** Advertise each HTML page's `.md` twin via an RFC 8288 `Link` response
   *  header (`Link: <…/foo.md>; rel="alternate"; type="text/markdown"`), so an
   *  agent can discover the twin from a plain GET — no UA match or `Accept`
   *  guess needed. Applies only to the normal HTML page response (a `200`
   *  `text/html` reply to an extension-less GET); the `.md` and pass-through
   *  responses are untouched. Default: `true`. */
  advertiseTwin?: boolean;
  /** Append `Vary: Accept` to the responses this worker negotiates on the
   *  `Accept` header (the `.md` twin, the HTML fallback when the twin is
   *  missing, and the normal HTML page), so a shared cache that honors `Vary`
   *  doesn't serve the HTML representation to a client that asked for
   *  markdown — or vice-versa (RFC 9110 §12.5.5). Cloudflare's CDN cache
   *  ignores `Vary` unless a Cache Rule's Vary setting covers `accept`. Merges with any existing
   *  `Vary` rather than replacing it; verbatim pass-through responses (non-GET,
   *  extension-bearing paths) are left untouched. Only `Accept` is listed:
   *  `User-Agent` is also (by default) a routing input, but `Vary: User-Agent` defeats
   *  shared caching (huge UA cardinality), so it is intentionally omitted. With User-Agent routing on, a bot's
   *  markdown reply is therefore cached under that bot's `Accept`; use
   *  `botUserAgents: false` when the cache must never cross-serve.
   *  Default: `false`. */
  vary?: boolean;
  /** Before advertising a page's `.md` twin in the `Link` header, fetch it from
   *  `ASSETS` and advertise it only when it exists (a `2xx` reply). Costs one
   *  extra local asset lookup per HTML page; worth it when some routes (error
   *  pages, dynamic outcomes) have no twin and an agent following the link
   *  would land on an error. Has no effect when `advertiseTwin` is `false`.
   *  Default: `false`. */
  checkTwin?: boolean;
  /** Also advertise an `llms.txt` index on each HTML page via
   *  `Link: </llms.txt>; rel="alternate"; type="text/plain"`. Pass `true` for
   *  `/llms.txt` or a path string for another location. Independent of
   *  `advertiseTwin`. Default: `false`. */
  advertiseLlmsTxt?: boolean | string;
  /** The origin your build bakes into absolute URLs (e.g. `https://example.com`,
   *  your Astro/Next `site`). On a request whose hostname differs (a preview
   *  deployment, a staging host), `og:image` and `twitter:image` URLs under this
   *  origin are rewritten to the origin being browsed, so images added in a
   *  preview resolve there. Nothing else is rewritten (`canonical` and `og:url`
   *  keep pointing at production), and it is a no-op on the canonical host.
   *  Uses `HTMLRewriter`; applies to HTML responses this worker negotiates.
   *  Default: unset (no rewriting). */
  canonicalOrigin?: string;
}

/** The function behind {@link createMdRouter}: call it from your own `fetch`
 *  when markdown negotiation is one step of a larger Worker. */
export type MdResponder<Env extends MdRouterEnv = MdRouterEnv> = (
  request: Request,
  env: Env
) => Promise<Response>;

const defaultMdPathFor = (pathname: string): string => {
  const trimmed = pathname.replace(/\/$/, "");
  return `${trimmed || "/index"}.md`;
};

/** Build a Cloudflare Workers fetch handler that serves the `.md` twin of
 *  a static page when the request looks like an LLM fetcher (known bot UA
 *  or `Accept: text/markdown`), falling back to the HTML response if the
 *  `.md` twin doesn't exist (any non-ok reply).
 *
 *  Pass through unchanged for non-GET, requests with a file extension,
 *  and "normal" browser requests — though the normal HTML page response also
 *  gets a `Link` header advertising its `.md` twin unless `advertiseTwin` is
 *  disabled (see {@link MdRouterOptions.advertiseTwin}). Opt into a
 *  `Vary: Accept` header on the `Accept`-negotiated responses with
 *  {@link MdRouterOptions.vary} so shared caches don't cross-serve the two
 *  representations.
 *
 *  Requires an `ASSETS` Fetcher binding in your `wrangler.jsonc`, and the Worker
 *  must run before the static-asset matcher for page routes (`run_worker_first`:
 *  `true` for every request, or an array of route patterns such as the one below
 *  that keeps asset requests off the Worker):
 *  ```jsonc
 *  {
 *    "main": "worker/index.ts",
 *    "assets": {
 *      "directory": "./dist",
 *      "binding": "ASSETS",
 *      "not_found_handling": "404-page",
 *      "html_handling": "drop-trailing-slash",
 *      "run_worker_first": ["/*", "!/_astro/*", "!/assets/*"]
 *    }
 *  }
 *  ```
 */
export function createMdRouter<Env extends MdRouterEnv = MdRouterEnv>(
  options: MdRouterOptions = {}
): ExportedHandler<Env> {
  const respond = createMdResponder<Env>(options);
  return {
    fetch: (request, env) => respond(request, env),
  };
}

/** Like {@link createMdRouter}, but returns a plain
 *  `(request, env) => Promise<Response>` function ({@link MdResponder}) so it
 *  can be called from inside a larger Worker, for example as the fallthrough
 *  after your own routes:
 *
 *  ```ts
 *  const respond = createMdResponder({ vary: true });
 *  export default {
 *    fetch: (request, env) =>
 *      new URL(request.url).pathname.startsWith("/api/")
 *        ? handleApi(request, env)
 *        : respond(request, env),
 *  };
 *  ```
 */
export function createMdResponder<Env extends MdRouterEnv = MdRouterEnv>(
  options: MdRouterOptions = {}
): MdResponder<Env> {
  const botUa = options.botUserAgents ?? LLM_BOT_UA;
  const mdPathFor = options.mdPathFor ?? defaultMdPathFor;
  const acceptTokens = ["text/markdown", ...(options.acceptMarkdown ?? [])];
  const advertiseTwin = options.advertiseTwin ?? true;
  const vary = options.vary ?? false;
  const checkTwin = options.checkTwin ?? false;
  const llmsTxtPath =
    options.advertiseLlmsTxt === true ? "/llms.txt" : options.advertiseLlmsTxt || undefined;
  const canonical = options.canonicalOrigin ? new URL(options.canonicalOrigin) : undefined;

  // Append `Vary: Accept` to a negotiated response when `vary` is enabled.
  // Wraps via `new Response(body, response)` because an asset response's
  // headers are immutable; `append` (not `set`) preserves any existing `Vary`.
  const withVary = (response: Response): Response => {
    if (!vary) {
      return response;
    }
    const varied = new Response(response.body, response);
    varied.headers.append("Vary", "Accept");
    return varied;
  };

  // Point absolute og:image / twitter:image URLs at the browsed origin. Matched
  // on hostname, not origin: `wrangler dev` serves a configured route's host
  // over plain http, and an origin comparison would turn `https://host/...`
  // into a `http://` URL that resolves nowhere.
  const withSocialImages = (response: Response, url: URL): Response => {
    if (!canonical || !response.body || url.hostname === canonical.hostname) {
      return response;
    }
    const type = (response.headers.get("Content-Type") ?? "").toLowerCase();
    if (!type.startsWith("text/html")) {
      return response;
    }
    const prefix = `${canonical.origin}/`;
    return new HTMLRewriter()
      .on('meta[property="og:image"], meta[name="twitter:image"]', {
        element(el) {
          const content = el.getAttribute("content");
          if (content?.startsWith(prefix)) {
            el.setAttribute("content", url.origin + content.slice(canonical.origin.length));
          }
        },
      })
      .transform(response);
  };

  const encodePath = (path: string): string =>
    path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

  return async (request, env) => {
    const url = new URL(request.url);

    if (request.method !== "GET" || /\.[a-zA-Z0-9]+$/.test(url.pathname)) {
      return env.ASSETS.fetch(request);
    }

    const accept = request.headers.get("Accept") ?? "";
    const ua = request.headers.get("User-Agent") ?? "";
    const wantsMarkdown =
      acceptTokens.some((tok) => accept.includes(tok)) || (botUa !== false && botUa.test(ua));
    const mdPath = mdPathFor(url.pathname);
    const fetchTwin = () => env.ASSETS.fetch(new Request(new URL(mdPath, url.origin), request));

    if (!wantsMarkdown) {
      const response = await env.ASSETS.fetch(request);
      const contentType = (response.headers.get("Content-Type") ?? "")
        .toLowerCase()
        .split(";")[0]
        .trim();
      if (contentType !== "text/html") {
        return withVary(response);
      }
      const advertiseMd =
        advertiseTwin && response.status === 200 && (!checkTwin || (await fetchTwin()).ok);
      const advertiseLlms = llmsTxtPath !== undefined && response.status === 200;
      // `new Response(body, response)` is the only way to add a header to an
      // otherwise-immutable asset response. A relative URI-Reference target is
      // valid per RFC 8288 (resolved against the request URL).
      const out = new Response(response.body, response);
      if (advertiseMd) {
        out.headers.append(
          "Link",
          `<${encodePath(mdPath)}>; rel="alternate"; type="text/markdown"`
        );
      }
      if (advertiseLlms) {
        out.headers.append(
          "Link",
          `<${encodePath(llmsTxtPath)}>; rel="alternate"; type="text/plain"`
        );
      }
      if (vary) {
        out.headers.append("Vary", "Accept");
      }
      return withSocialImages(out, url);
    }

    const mdResponse = await fetchTwin();

    if (!mdResponse.ok) {
      return withSocialImages(withVary(await env.ASSETS.fetch(request)), url);
    }
    // Static-asset hosts may type a `.md` file as text/plain or octet-stream.
    const markdown = new Response(mdResponse.body, mdResponse);
    markdown.headers.set("Content-Type", "text/markdown; charset=utf-8");
    return withVary(markdown);
  };
}

/** Default-configured handler. Equivalent to `createMdRouter()`. Re-export
 *  this as your worker's default to use it without any customization:
 *
 *  ```ts
 *  // worker/index.ts
 *  export { default } from "@wave-rf/cloudflare-md-router/worker";
 *  ```
 */
export const mdRouter: ExportedHandler<MdRouterEnv> = createMdRouter();

export default mdRouter;
