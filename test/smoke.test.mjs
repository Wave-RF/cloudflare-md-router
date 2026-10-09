/* End-to-end: a throwaway site in a temp dir with a fake build and a fake `wrangler` package in its
 * node_modules. No network, no real wrangler, nothing outside the temp dirs.
 *
 * The fakes record their pids (in a log dir OUTSIDE the site, so `--watch .` sees none of it), and
 * every test asserts those processes are gone once the CLI has exited: an orphaned wrangler or build
 * holds the CLI's stdio pipes open, which is how a lifecycle bug used to hang CI rather than fail it.
 * Each test also has a timeout and kills every recorded pid afterwards, pass or fail. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { syncDirs } from "../bin/dev.mjs";

const CLI = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const TIMEOUT = { timeout: 60_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, what, ms = 20000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
};
const hasPm = (pm) => spawnSync(pm, ["--version"], { stdio: "ignore" }).status === 0;
const PMS = ["npm", "pnpm"].map((pm) => [pm, hasPm(pm) ? false : `${pm} is not on PATH`]);
let nextPort = 49310;

function makeSite(pm = "npm") {
  const root = mkdtempSync(join(tmpdir(), "mdr-smoke-"));
  const logs = mkdtempSync(join(tmpdir(), "mdr-smoke-logs-"));
  const w = (name, text) => {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  };
  w("package.json", '{"name":"fixture","private":true,"scripts":{"build":"node build.mjs"}}');
  if (pm === "pnpm") w("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  else w("package-lock.json", "{}");
  w("wrangler.jsonc", '{ // comment\n "name": "fixture", "assets": { "directory": "./out" } }');
  w("src/page.txt", "v1");
  // The fake "framework build": writes into $MD_ROUTER_DEV_OUT_DIR (or --outDir); fails or hangs
  // on demand.
  w(
    "build.mjs",
    `import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
const logs = process.env.FIXTURE_LOGS;
appendFileSync(logs + "/build.pids", process.pid + "\\n");
const out = process.argv[process.argv.indexOf("--outDir") + 1];
if (out !== process.env.MD_ROUTER_DEV_OUT_DIR) { console.error("outDir mismatch", out); process.exit(3); }
appendFileSync(logs + "/env.log", "MD_ROUTER_DEV=" + process.env.MD_ROUTER_DEV + "\\n");
const src = readFileSync("src/page.txt", "utf8");
if (src.includes("SLOW")) setInterval(() => {}, 1000);
else if (src.includes("FAIL")) { mkdirSync(out, { recursive: true }); writeFileSync(out + "/index.html", "HALF-BUILT"); process.exit(1); }
else {
  mkdirSync(out + "/sub", { recursive: true });
  writeFileSync(out + "/index.html", src);
  writeFileSync(out + "/sub/" + src + ".html", src);
}
`
  );
  // A fake wrangler package, shaped like the real one (bin map → bin/wrangler.js).
  w(
    "node_modules/wrangler/package.json",
    '{"name":"wrangler","bin":{"wrangler":"bin/wrangler.js"}}'
  );
  w(
    "node_modules/wrangler/bin/wrangler.js",
    `const fs = require("node:fs");
const logs = process.env.FIXTURE_LOGS;
fs.writeFileSync(logs + "/wrangler.pid", String(process.pid));
fs.writeFileSync(logs + "/wrangler.args", process.argv.slice(2).join(" "));
const stubborn = fs.existsSync(logs + "/stubborn");
const stop = () => { fs.writeFileSync(logs + "/wrangler.stopped", "1"); if (!stubborn) process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
setInterval(() => {}, 1000);
`
  );
  // What a package manager's `exec` finds (the fallback when the package can't be resolved).
  w("node_modules/.bin/wrangler", '#!/usr/bin/env node\nrequire("../wrangler/bin/wrangler.js");\n');
  spawnSync("chmod", ["755", join(root, "node_modules/.bin/wrangler")]);
  return { root, logs, out: join(root, "out") };
}

/** Start the CLI in `site.root`; every pid the fixture records is killed when the test ends. */
function startDev(t, site, args) {
  const port = nextPort;
  nextPort += 20;
  const child = spawn(process.execPath, [CLI, "dev", "--port", String(port), ...args], {
    cwd: site.root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: undefined, FIXTURE_LOGS: site.logs },
  });
  let log = "";
  child.stdout.on("data", (b) => {
    log += b;
  });
  child.stderr.on("data", (b) => {
    log += b;
  });
  // `exit`, not `close`: an orphan holding the pipes must fail the pid assertions, not hang here.
  const exited = new Promise((r) => child.on("exit", (code, sig) => r(code ?? sig)));
  t.after(() => {
    for (const pid of [child.pid, ...pids(site)]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(site.root, { recursive: true, force: true });
    rmSync(site.logs, { recursive: true, force: true });
  });
  return { child, exited, log: () => log };
}

const read = (site, name) => readFileSync(join(site.logs, name), "utf8");
const has = (site, name) => existsSync(join(site.logs, name));
function pids(site) {
  const list = [];
  if (has(site, "wrangler.pid")) list.push(Number(read(site, "wrangler.pid")));
  if (has(site, "build.pids")) list.push(...read(site, "build.pids").split("\n").filter(Boolean));
  return list.map(Number);
}
function assertGone(pid, what) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `${what} (pid ${pid}) outlived dev`);
}
const assertAllGone = (site) => {
  for (const pid of pids(site)) assertGone(pid, "a fixture process");
};

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

for (const [pm, skip] of PMS) {
  test(`dev loop (${pm}): swaps in good builds, keeps the last good one on failure, stops wrangler`, {
    ...TIMEOUT,
    skip,
  }, async (t) => {
    const site = makeSite(pm);
    const { out } = site;
    // The default build: the site's "build" script through the package manager.
    const dev = startDev(t, site, []);
    // First build is synchronous with startup; wrangler starts after it.
    await until(() => has(site, "wrangler.args"), "wrangler to start");
    assert.match(dev.log(), new RegExp(`build: ${pm} run build`));
    assert.equal(readFileSync(join(out, "index.html"), "utf8"), "v1");
    assert.equal(existsSync(join(out, "sub", "v1.html")), true);
    assert.match(
      read(site, "wrangler.args"),
      /dev --live-reload --port \d+ --config .*wrangler\.jsonc/
    );
    assert.match(read(site, "env.log"), /MD_ROUTER_DEV=1/);

    // A successful rebuild swaps in new output and prunes what the build dropped.
    writeFileSync(join(site.root, "src/page.txt"), "v2");
    await until(() => existsSync(join(out, "sub", "v2.html")), "v2 to land");
    assert.equal(readFileSync(join(out, "index.html"), "utf8"), "v2");
    assert.equal(existsSync(join(out, "sub", "v1.html")), false);

    // A failing build (which also wrote half-built junk) must NOT touch the served output.
    writeFileSync(join(site.root, "src/page.txt"), "FAIL");
    await until(() => dev.log().includes("FAILED (exit 1)"), "failure banner");
    assert.ok(dev.log().includes("\x07"), "bell");
    assert.ok(dev.log().includes("still serving the previous good build"));
    assert.equal(readFileSync(join(out, "index.html"), "utf8"), "v2");
    assert.equal(existsSync(join(out, "sub", "v2.html")), true);

    // Recovery.
    writeFileSync(join(site.root, "src/page.txt"), "v3");
    await until(() => existsSync(join(out, "sub", "v3.html")), "v3 to land");
    assert.equal(readFileSync(join(out, "index.html"), "utf8"), "v3");

    dev.child.kill("SIGINT");
    assert.equal(await dev.exited, 0);
    assertAllGone(site);
    assert.ok(has(site, "wrangler.stopped"), "wrangler got a graceful signal");
  });

  test(`wrangler run through the ${pm} fallback is stopped too`, {
    ...TIMEOUT,
    skip,
  }, async (t) => {
    const site = makeSite(pm);
    // Unresolvable as a package (as under Yarn PnP): the package manager's exec runs .bin/wrangler.
    unlinkSync(join(site.root, "node_modules/wrangler/package.json"));
    const dev = startDev(t, site, ["--build", "node build.mjs"]);
    await until(() => has(site, "wrangler.pid"), "wrangler to start");
    assert.match(dev.log(), new RegExp(`no wrangler package resolvable .* running \`${pm} exec`));
    dev.child.kill("SIGINT");
    assert.equal(await dev.exited, 0);
    assertAllGone(site);
  });

  for (const [how, args] of [
    ["the package manager", []],
    ["a --build shell", ["--build", "node build.mjs"]],
  ]) {
    test(`stopping mid-build (${pm}, via ${how}) kills the whole build tree`, {
      ...TIMEOUT,
      skip,
    }, async (t) => {
      const site = makeSite(pm);
      writeFileSync(join(site.root, "src/page.txt"), "SLOW");
      const dev = startDev(t, site, args);
      await until(() => has(site, "build.pids"), "the build to start");
      dev.child.kill("SIGINT");
      assert.equal(await dev.exited, 0);
      assert.equal(has(site, "wrangler.pid"), false);
      assertAllGone(site);
    });
  }
}

test("a wrangler that ignores SIGTERM is SIGKILLed, and dev waits for it and for a running build", {
  ...TIMEOUT,
}, async (t) => {
  const site = makeSite();
  writeFileSync(join(site.logs, "stubborn"), "");
  const dev = startDev(t, site, ["--build", "node build.mjs"]);
  await until(() => has(site, "wrangler.pid"), "wrangler to start");
  writeFileSync(join(site.root, "src/page.txt"), "SLOW"); // a rebuild that never finishes
  await until(() => read(site, "build.pids").trim().split("\n").length === 2, "the rebuild");
  dev.child.kill("SIGINT");
  assert.equal(await dev.exited, 0);
  assertAllGone(site);
  assert.ok(has(site, "wrangler.stopped"), "SIGTERM was tried first");
  assert.match(dev.log(), /sending SIGKILL/);
});

test("wrangler dying of a signal takes dev down with a non-zero exit", TIMEOUT, async (t) => {
  const site = makeSite();
  const dev = startDev(t, site, ["--build", "node build.mjs"]);
  await until(() => has(site, "wrangler.pid"), "wrangler to start");
  process.kill(Number(read(site, "wrangler.pid")), "SIGKILL");
  assert.equal(await dev.exited, 1);
  assertAllGone(site);
});

test(
  "--watch . builds once per edit: its own output, staging and node_modules are ignored",
  TIMEOUT,
  async (t) => {
    const site = makeSite();
    const dev = startDev(t, site, ["--build", "node build.mjs", "--watch", "."]);
    await until(() => has(site, "wrangler.pid"), "wrangler to start");
    await sleep(1500);
    const builds = () => read(site, "build.pids").trim().split("\n").length;
    assert.equal(builds(), 1, "no rebuild from the first build's own output");
    writeFileSync(join(site.root, "src/page.txt"), "v2");
    await until(() => existsSync(join(site.out, "sub", "v2.html")), "v2 to land");
    writeFileSync(join(site.root, "node_modules/noise.txt"), "x");
    await sleep(1500);
    assert.equal(builds(), 2, `one build per edit, got ${builds()}:\n${dev.log()}`);
    dev.child.kill("SIGINT");
    assert.equal(await dev.exited, 0);
    assertAllGone(site);
  }
);

test(
  "a build that writes to the output dir directly is called out, not reported as empty",
  TIMEOUT,
  async (t) => {
    const site = makeSite();
    writeFileSync(
      join(site.root, "direct.mjs"),
      'import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("out", { recursive: true });\nwriteFileSync("out/index.html", String(Date.now()));\n'
    );
    const dev = startDev(t, site, ["--build", "node direct.mjs", "--out-dir-flag", ""]);
    await until(() => has(site, "wrangler.pid"), "wrangler to start");
    assert.match(dev.log(), /wrote to out\/ directly, not \.dev-out\//);
    assert.doesNotMatch(dev.log(), /wrote nothing/);
    dev.child.kill("SIGINT");
    assert.equal(await dev.exited, 0);
    assertAllGone(site);
  }
);

test(
  "a build that writes nothing anywhere keeps serving the previous build",
  TIMEOUT,
  async (t) => {
    const site = makeSite();
    mkdirSync(site.out);
    writeFileSync(join(site.out, "index.html"), "old");
    const dev = startDev(t, site, ["--build", "node -e 0", "--out-dir-flag", ""]);
    await until(() => dev.log().includes("wrote nothing"), "the empty-build banner");
    assert.match(dev.log(), /wrote nothing to \.dev-out\/ — still serving the previous good build/);
    assert.equal(readFileSync(join(site.out, "index.html"), "utf8"), "old");
    await until(() => has(site, "wrangler.pid"), "wrangler to start");
    dev.child.kill("SIGINT");
    assert.equal(await dev.exited, 0);
    assertAllGone(site);
  }
);

test(
  "a failed first build with nothing to serve exits non-zero without starting wrangler",
  TIMEOUT,
  async (t) => {
    const site = makeSite();
    writeFileSync(join(site.root, "src/page.txt"), "FAIL");
    const dev = startDev(t, site, ["--build", "node build.mjs"]);
    assert.equal(await dev.exited, 1);
    assert.equal(has(site, "wrangler.args"), false);
    assert.equal(existsSync(join(site.out, "index.html")), false);
    assertAllGone(site);
  }
);
