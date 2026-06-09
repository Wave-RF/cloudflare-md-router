import { LLM_BOT_UA } from "./bots.ts";

export interface MdRouterEnv {
  ASSETS: Fetcher;
}

export interface MdRouterOptions {
  /** Override the default LLM-bot User-Agent matcher. Default: {@link LLM_BOT_UA}. */
  botUserAgents?: RegExp;
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
}

const defaultMdPathFor = (pathname: string): string => {
  const trimmed = pathname.replace(/\/$/, "");
  return (trimmed || "/index") + ".md";
};

/** Build a Cloudflare Workers fetch handler that serves the `.md` twin of
 *  a static page when the request looks like an LLM fetcher (known bot UA
 *  or `Accept: text/markdown`), falling back to the HTML response if the
 *  `.md` twin doesn't exist (404).
 *
 *  Pass through unchanged for non-GET, requests with a file extension,
 *  and "normal" browser requests — though the normal HTML page response also
 *  gets a `Link` header advertising its `.md` twin unless `advertiseTwin` is
 *  disabled (see {@link MdRouterOptions.advertiseTwin}).
 *
 *  Requires an `ASSETS` Fetcher binding in your `wrangler.jsonc`:
 *  ```jsonc
 *  {
 *    "main": "worker/index.ts",
 *    "assets": {
 *      "directory": "./dist",
 *      "binding": "ASSETS",
 *      "not_found_handling": "404-page",
 *      "html_handling": "drop-trailing-slash",
 *      "run_worker_first": true
 *    }
 *  }
 *  ```
 */
export function createMdRouter<Env extends MdRouterEnv = MdRouterEnv>(
  options: MdRouterOptions = {},
): ExportedHandler<Env> {
  const botUa = options.botUserAgents ?? LLM_BOT_UA;
  const mdPathFor = options.mdPathFor ?? defaultMdPathFor;
  const acceptTokens = ["text/markdown", ...(options.acceptMarkdown ?? [])];
  const advertiseTwin = options.advertiseTwin ?? true;

  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);

      if (request.method !== "GET" || /\.[a-zA-Z0-9]+$/.test(url.pathname)) {
        return env.ASSETS.fetch(request);
      }

      const accept = request.headers.get("Accept") ?? "";
      const ua = request.headers.get("User-Agent") ?? "";
      const wantsMarkdown =
        acceptTokens.some((tok) => accept.includes(tok)) || botUa.test(ua);

      if (!wantsMarkdown) {
        const response = await env.ASSETS.fetch(request);
        const isHtml = (response.headers.get("Content-Type") ?? "").toLowerCase().includes("text/html");
        if (!advertiseTwin || response.status !== 200 || !isHtml) {
          return response;
        }
        // `new Response(body, response)` is the only way to add a header to an
        // otherwise-immutable asset response. A relative URI-Reference target is
        // valid per RFC 8288 (resolved against the request URL).
        const withTwin = new Response(response.body, response);
        withTwin.headers.append(
          "Link",
          `<${mdPathFor(url.pathname)}>; rel="alternate"; type="text/markdown"`,
        );
        return withTwin;
      }

      const mdPath = mdPathFor(url.pathname);
      const mdResponse = await env.ASSETS.fetch(
        new Request(new URL(mdPath, url.origin), request),
      );

      return mdResponse.status === 404 ? env.ASSETS.fetch(request) : mdResponse;
    },
  };
}

/** Default-configured handler. Equivalent to `createMdRouter()`. Re-export
 *  this as your worker's default to use it without any customization:
 *
 *  ```ts
 *  // worker/index.ts
 *  export { default } from "cloudflare-md-router/worker";
 *  ```
 */
export const mdRouter: ExportedHandler<MdRouterEnv> = createMdRouter();

export default mdRouter;
