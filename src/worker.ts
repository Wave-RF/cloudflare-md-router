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
 *  and "normal" browser requests.
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
        return env.ASSETS.fetch(request);
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
