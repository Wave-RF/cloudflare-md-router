/* End-to-end: a throwaway site in a temp dir with a fake build command and a fake `wrangler` on the
 * local bin path. No network, no real wrangler, nothing outside the temp dir. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { syncDirs } from "../bin/dev.mjs";

const CLI = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const until = async (cond, what, ms = 20000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

function makeSite() {
  const root = mkdtempSync(join(tmpdir(), "mdr-smoke-"));
  const w = (name, text) => {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  };
  w("package.json", '{"name":"fixture","private":true,"scripts":{"build":"echo unused"}}');
  w("package-lock.json", "{}");
  w("wrangler.jsonc", '{ // comment\n "name": "fixture", "assets": { "directory": "./out" } }');
  w("src/page.txt", "v1");
  // The fake "framework build": writes into $MD_ROUTER_DEV_OUT_DIR (or --outDir), fails on demand.
  w(
    "build.mjs",
    `import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--outDir") + 1];
if (out !== process.env.MD_ROUTER_DEV_OUT_DIR) { console.error("outDir mismatch", out); process.exit(3); }
appendFileSync("env.log", "MD_ROUTER_DEV=" + process.env.MD_ROUTER_DEV + "\\n");
const src = readFileSync("src/page.txt", "utf8");
if (src.includes("FAIL")) { mkdirSync(out, { recursive: true }); writeFileSync(out + "/index.html", "HALF-BUILT"); process.exit(1); }
mkdirSync(out + "/sub", { recursive: true });
writeFileSync(out + "/index.html", src);
writeFileSync(out + "/sub/" + src + ".html", src);
`
  );
  w(
    "node_modules/.bin/wrangler",
    `#!/usr/bin/env node
require("node:fs").writeFileSync("wrangler.args", process.argv.slice(2).join(" "));
const stop = () => { require("node:fs").writeFileSync("wrangler.stopped", "1"); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
setInterval(() => {}, 1000);
`
  );
  chmodSync(join(root, "node_modules/.bin/wrangler"), 0o755);
  return root;
}

test("syncDirs prunes dropped entries and handles file <-> directory type changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "mdr-sync-"));
  const s = join(root, "s");
  const d = join(root, "d");
  mkdirSync(join(d, "gone"), { recursive: true });
  mkdirSync(join(d, "flip"), { recursive: true });
  writeFileSync(join(d, "gone", "x"), "x");
  writeFileSync(join(d, "flip", "x"), "x");
  writeFileSync(join(d, "was-file"), "x");
  mkdirSync(join(s, "was-file"), { recursive: true });
  writeFileSync(join(s, "was-file", "y"), "y");
  writeFileSync(join(s, "flip"), "now a file");
  await syncDirs(s, d);
  assert.equal(existsSync(join(d, "gone")), false);
  assert.equal(readFileSync(join(d, "flip"), "utf8"), "now a file");
  assert.equal(readFileSync(join(d, "was-file", "y"), "utf8"), "y");
  rmSync(root, { recursive: true, force: true });
});

test("dev loop: swaps in good builds, keeps the last good one on failure, stops both children", async () => {
  const root = makeSite();
  const out = join(root, "out");
  let log = "";
  const child = spawn(
    process.execPath,
    [CLI, "dev", "--build", "node build.mjs", "--port", "49310"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: undefined } }
  );
  child.stdout.on("data", (b) => {
    log += b;
  });
  child.stderr.on("data", (b) => {
    log += b;
  });
  const exited = new Promise((r) => child.on("close", r));
  try {
    // First build is synchronous with startup; wrangler starts after it.
    await until(() => existsSync(join(root, "wrangler.args")), "wrangler to start");
    assert.equal(readFileSync(join(out, "index.html"), "utf8"), "v1");
    assert.equal(existsSync(join(out, "sub", "v1.html")), true);
    const args = readFileSync(join(root, "wrangler.args"), "utf8");
    assert.match(args, /dev --live-reload --port \d+ --config .*wrangler\.jsonc/);
    assert.match(readFileSync(join(root, "env.log"), "utf8"), /MD_ROUTER_DEV=1/);

    // A successful rebuild swaps in new output and prunes what the build dropped.
    writeFileSync(join(root, "src/page.txt"), "v2");
    await until(() => existsSync(join(out, "sub", "v2.html")), "v2 to land");
    assert.equal(readFileSync(join(out, "index.html"), "utf8"), "v2");
    assert.equal(existsSync(join(out, "sub", "v1.html")), false);

    // A failing build (which also wrote half-built junk) must NOT touch the served output.
    writeFileSync(join(root, "src/page.txt"), "FAIL");
    await until(() => log.includes("FAILED (exit 1)"), "failure banner");
    assert.ok(log.includes("\x07"), "bell");
    assert.ok(log.includes("still serving the previous good build"));
    assert.equal(readFileSync(join(out, "index.html"), "utf8"), "v2");
    assert.equal(existsSync(join(out, "sub", "v2.html")), true);

    // Recovery.
    writeFileSync(join(root, "src/page.txt"), "v3");
    await until(() => existsSync(join(out, "sub", "v3.html")), "v3 to land");
    assert.equal(readFileSync(join(out, "index.html"), "utf8"), "v3");
  } finally {
    child.kill("SIGINT");
  }
  const code = await exited;
  assert.equal(code, 0);
  await until(() => existsSync(join(root, "wrangler.stopped")), "wrangler to be stopped");
  rmSync(root, { recursive: true, force: true });
});

test("a failed first build with nothing to serve exits non-zero without starting wrangler", async () => {
  const root = makeSite();
  writeFileSync(join(root, "src/page.txt"), "FAIL");
  const child = spawn(
    process.execPath,
    [CLI, "dev", "--build", "node build.mjs", "--port", "49330"],
    {
      cwd: root,
      stdio: "ignore",
    }
  );
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 1);
  assert.equal(existsSync(join(root, "wrangler.args")), false);
  assert.equal(existsSync(join(root, "out", "index.html")), false);
  rmSync(root, { recursive: true, force: true });
});
