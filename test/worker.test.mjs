/* The Worker's routing, against a stub ASSETS binding. `HTMLRewriter` is a Workers global, so a
 * minimal stand-in covers the one use the router makes of it (rewriting `<meta content>`). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { LLM_BOT_UA } from "../src/bots.ts";
import { createMdResponder, createMdRouter } from "../src/worker.ts";

globalThis.HTMLRewriter = class {
  #handler;
  on(_selector, handler) {
    this.#handler = handler;
    return this;
  }
  transform(response) {
    const handler = this.#handler;
    const stream = new ReadableStream({
      async start(controller) {
        const html = await response.text();
        const out = html.replace(/<meta [^>]*>/g, (tag) => {
          if (!/(property="og:image"|name="twitter:image")/.test(tag)) return tag;
          const m = /content="([^"]*)"/.exec(tag);
          let content = m[1];
          handler.element({
            getAttribute: () => content,
            setAttribute: (_n, v) => {
              content = v;
            },
          });
          return tag.replace(/content="[^"]*"/, `content="${content}"`);
        });
        controller.enqueue(new TextEncoder().encode(out));
        controller.close();
      },
    });
    return new Response(stream, response);
  }
};

const PAGE = `<meta property="og:image" content="https://example.com/a.png"><meta name="twitter:image" content="https://example.com/a.png"><meta property="og:url" content="https://example.com/x">`;

function assets(files) {
  const calls = [];
  return {
    calls,
    fetch: async (req) => {
      const path = new URL(req instanceof Request ? req.url : req).pathname;
      calls.push(path);
      const file = files[path];
      if (!file) return new Response("nope", { status: 404 });
      return new Response(file.body, {
        status: file.status ?? 200,
        headers: { "content-type": file.type },
      });
    },
  };
}
const html = (body = PAGE, status) => ({ body, type: "text/html; charset=utf-8", status });
const get = (url, headers) => new Request(url, { headers });
const links = (res) => res.headers.get("link");

test("twin Link is advertised by default, and only when the twin exists with checkTwin", async () => {
  const files = { "/a": html(), "/a.md": { body: "# a", type: "text/markdown" }, "/b": html() };
  const cases = [
    [{}, "/a", '</a.md>; rel="alternate"; type="text/markdown"'],
    [{}, "/b", '</b.md>; rel="alternate"; type="text/markdown"'],
    [{ checkTwin: true }, "/a", '</a.md>; rel="alternate"; type="text/markdown"'],
    [{ checkTwin: true }, "/b", null],
  ];
  for (const [options, path, want] of cases) {
    const res = await createMdRouter(options).fetch(get(`https://x.test${path}`), {
      ASSETS: assets(files),
    });
    assert.equal(links(res), want, `${JSON.stringify(options)} ${path}`);
  }
});

test("advertiseLlmsTxt adds a text/plain alternate link, independent of the twin link", async () => {
  const env = () => ({ ASSETS: assets({ "/a": html() }) });
  const cases = [
    [
      { advertiseLlmsTxt: true },
      '</a.md>; rel="alternate"; type="text/markdown", </llms.txt>; rel="alternate"; type="text/plain"',
    ],
    [
      { advertiseLlmsTxt: "/docs/llms.txt", advertiseTwin: false },
      '</docs/llms.txt>; rel="alternate"; type="text/plain"',
    ],
    [{}, '</a.md>; rel="alternate"; type="text/markdown"'],
  ];
  for (const [options, want] of cases) {
    const res = await createMdRouter(options).fetch(get("https://x.test/a"), env());
    assert.equal(links(res), want, JSON.stringify(options));
  }
});

test("the default bot list matches the added crawlers", () => {
  for (const ua of [
    "Claude-User",
    "Claude-SearchBot",
    "Amazonbot/0.1",
    "DuckAssistBot",
    "GPTBot/1.0",
  ]) {
    assert.match(ua, LLM_BOT_UA);
  }
  assert.doesNotMatch("Mozilla/5.0 Safari", LLM_BOT_UA);
});

test("canonicalOrigin rewrites only social images, and only off the canonical host", async () => {
  const env = () => ({ ASSETS: assets({ "/a": html() }) });
  const router = createMdRouter({ canonicalOrigin: "https://example.com" });
  const preview = await (await router.fetch(get("https://pr-1.preview.dev/a"), env())).text();
  assert.match(preview, /og:image" content="https:\/\/pr-1\.preview\.dev\/a\.png"/);
  assert.match(preview, /twitter:image" content="https:\/\/pr-1\.preview\.dev\/a\.png"/);
  assert.match(preview, /og:url" content="https:\/\/example\.com\/x"/);
  const prod = await (await router.fetch(get("https://example.com/a"), env())).text();
  assert.equal(prod, PAGE);
  const unset = await (
    await createMdRouter().fetch(get("https://pr-1.preview.dev/a"), env())
  ).text();
  assert.equal(unset, PAGE);
});

test("markdown requests get the twin; a missing twin falls back to HTML; vary is opt-in", async () => {
  const files = { "/a": html(), "/a.md": { body: "# a", type: "text/markdown" } };
  const env = () => ({ ASSETS: assets(files) });
  const md = await createMdRouter({ vary: true }).fetch(
    get("https://x.test/a", { accept: "text/markdown" }),
    env()
  );
  assert.equal(await md.text(), "# a");
  assert.equal(md.headers.get("vary"), "Accept");
  const bot = await createMdRouter().fetch(
    get("https://x.test/a", { "user-agent": "Claude-User" }),
    env()
  );
  assert.equal(await bot.text(), "# a");
  const fallback = await createMdRouter().fetch(
    get("https://x.test/b", { accept: "text/markdown" }),
    {
      ASSETS: assets({ "/b": html("<p>b</p>") }),
    }
  );
  assert.equal(await fallback.text(), "<p>b</p>");
});

test("createMdResponder is the router's fetch as a plain function", async () => {
  const env = { ASSETS: assets({ "/a": html() }) };
  const res = await createMdResponder()(get("https://x.test/a"), env);
  assert.equal(links(res), '</a.md>; rel="alternate"; type="text/markdown"');
});

test("a twin is served as text/markdown, and any non-ok twin reply falls back to HTML", async () => {
  const typed = await createMdRouter().fetch(get("https://x.test/a", { accept: "text/markdown" }), {
    ASSETS: assets({ "/a": html(), "/a.md": { body: "# a", type: "text/plain" } }),
  });
  assert.equal(typed.headers.get("content-type"), "text/markdown; charset=utf-8");
  for (const status of [403, 500]) {
    const res = await createMdRouter().fetch(get("https://x.test/a", { accept: "text/markdown" }), {
      ASSETS: assets({
        "/a": html("<p>a</p>"),
        "/a.md": { body: "err", type: "text/plain", status },
      }),
    });
    assert.equal(await res.text(), "<p>a</p>", `status ${status}`);
  }
});

test("a bot User-Agent gets the twin by default; botUserAgents: false routes on Accept only", async () => {
  const files = { "/a": html("<p>a</p>"), "/a.md": { body: "# a", type: "text/markdown" } };
  const env = () => ({ ASSETS: assets(files) });
  const bot = { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.1)" };

  const byDefault = await createMdRouter().fetch(get("https://x.test/a", bot), env());
  assert.equal(await byDefault.text(), "# a");

  const off = await createMdRouter({ botUserAgents: false }).fetch(
    get("https://x.test/a", bot),
    env()
  );
  assert.equal(await off.text(), "<p>a</p>");
  assert.equal(links(off), '</a.md>; rel="alternate"; type="text/markdown"');

  for (const options of [{}, { botUserAgents: false }]) {
    const res = await createMdRouter(options).fetch(
      get("https://x.test/a", { ...bot, accept: "text/markdown" }),
      env()
    );
    assert.equal(await res.text(), "# a", JSON.stringify(options));
    assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
  }

  const token = await createMdRouter({
    botUserAgents: false,
    acceptMarkdown: ["text/x-markdown"],
  }).fetch(get("https://x.test/a", { accept: "text/x-markdown" }), env());
  assert.equal(await token.text(), "# a");
});

test("with botUserAgents: false a missing twin still falls back to HTML on an Accept match", async () => {
  const res = await createMdRouter({ botUserAgents: false }).fetch(
    get("https://x.test/b", { accept: "text/markdown" }),
    { ASSETS: assets({ "/b": html("<p>b</p>") }) }
  );
  assert.equal(await res.text(), "<p>b</p>");
});

// A stub that behaves like the asset worker: a conditional request gets a 304 when `If-None-Match`
// equals the ETag of whatever the path RESOLVES to, and a missing path resolves to the 404 page
// (`not_found_handling: "404-page"`), which has its own ETag.
const E404 = '"etag-404"';
const ETAG_TWIN = '"etag-twin"';
const ETAG_PAGE = '"etag-page"';
function assetWorker({ twin = true } = {}) {
  const calls = [];
  const files = {
    "/a": { body: "<p>a</p>", type: "text/html", etag: ETAG_PAGE },
    ...(twin && { "/a.md": { body: "# a", type: "text/plain", etag: ETAG_TWIN } }),
  };
  return {
    calls,
    fetch: async (req) => {
      const { pathname } = new URL(req.url);
      calls.push({ pathname, inm: req.headers.get("if-none-match") });
      const file = files[pathname];
      const resolved = file ?? { body: "<p>404</p>", type: "text/html", etag: E404 };
      const headers = { "content-type": resolved.type, etag: resolved.etag };
      if (req.headers.get("if-none-match") === resolved.etag) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(resolved.body, { status: file ? 200 : 404, headers });
    },
  };
}
const mdGet = (inm) => get("https://x.test/a", { accept: "text/markdown", "if-none-match": inm });
const browserGet = (inm) => get("https://x.test/a", { accept: "text/html", "if-none-match": inm });

test("a revalidating markdown client gets the full twin; the twin request carries no validators", async () => {
  const stub = assetWorker();
  const res = await createMdRouter({ vary: true }).fetch(mdGet(ETAG_TWIN), { ASSETS: stub });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "# a");
  assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(res.headers.get("vary"), "Accept");
  assert.deepEqual(stub.calls, [{ pathname: "/a.md", inm: null }]);
});

test("a markdown client holding the 404 page's ETag gets the HTML fallback, not a 304", async () => {
  const stub = assetWorker({ twin: false });
  const res = await createMdRouter().fetch(mdGet(E404), { ASSETS: stub });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html");
  assert.equal(await res.text(), "<p>a</p>");
  // The twin without validators, then the page via the original request, validators intact.
  assert.deepEqual(stub.calls, [
    { pathname: "/a.md", inm: null },
    { pathname: "/a", inm: E404 },
  ]);
});

test("every client validator is stripped from the twin request", async () => {
  const stub = assetWorker();
  await createMdRouter().fetch(
    get("https://x.test/a", {
      accept: "text/markdown",
      "if-none-match": ETAG_TWIN,
      "if-modified-since": "Wed, 21 Oct 2015 07:28:00 GMT",
      "if-match": ETAG_TWIN,
      "if-unmodified-since": "Wed, 21 Oct 2015 07:28:00 GMT",
      "if-range": ETAG_TWIN,
    }),
    { ASSETS: stub }
  );
  assert.deepEqual(stub.calls, [{ pathname: "/a.md", inm: null }]);
});

test("checkTwin: no Link when the twin is missing, even for a client holding the 404 ETag", async () => {
  const stub = assetWorker({ twin: false });
  const res = await createMdRouter({ checkTwin: true }).fetch(browserGet(E404), { ASSETS: stub });
  assert.equal(res.status, 200);
  assert.equal(links(res), null);
});

test("checkTwin: Link when the twin exists, even for a client holding the twin's ETag", async () => {
  const stub = assetWorker();
  const res = await createMdRouter({ checkTwin: true }).fetch(browserGet(ETAG_TWIN), {
    ASSETS: stub,
  });
  assert.equal(res.status, 200);
  assert.equal(links(res), '</a.md>; rel="alternate"; type="text/markdown"');
  assert.equal(stub.calls.length, 2);
});

test("a browser's conditional request matching the page's ETag gets the page's 304, untouched", async () => {
  const stub = assetWorker();
  const res = await createMdRouter().fetch(browserGet(ETAG_PAGE), { ASSETS: stub });
  assert.equal(res.status, 304);
  assert.equal(links(res), null);
  assert.deepEqual(stub.calls, [{ pathname: "/a", inm: ETAG_PAGE }]);
});

test("a browser request gets the HTML page, plus only the documented Link", async () => {
  const stub = assetWorker();
  const res = await createMdRouter().fetch(
    get("https://x.test/a", { accept: "text/html", "user-agent": "Mozilla/5.0 Safari" }),
    { ASSETS: stub }
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<p>a</p>");
  assert.equal(links(res), '</a.md>; rel="alternate"; type="text/markdown"');
  assert.deepEqual(
    stub.calls.map((c) => c.pathname),
    ["/a"]
  );
});
