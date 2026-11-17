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
