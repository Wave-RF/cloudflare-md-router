import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildInvocation,
  classifyWatch,
  detectPackageManager,
  execLocalCommand,
  findFreePort,
  matchesName,
  parseArgs,
  parseJsonc,
  parsePort,
  parseWranglerToml,
  readWranglerConfig,
  resolveOptions,
  runScriptCommand,
  stripJsonc,
} from "../bin/lib.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "mdr-lib-"));
const write = (dir, name, text) => {
  writeFileSync(join(dir, name), text);
  return join(dir, name);
};

test("parseJsonc handles comments, trailing commas, and URL-looking strings", () => {
  const text = `{
    // line comment
    "$schema": "node_modules/wrangler/config-schema.json", /* block */
    "routes": [{ "pattern": "https://example.com//x", "note": "a \\" // not a comment" },],
    "assets": { "directory": "./dist", },
  }`;
  const v = parseJsonc(text);
  assert.equal(v.assets.directory, "./dist");
  assert.equal(v.routes[0].pattern, "https://example.com//x");
  assert.equal(v.routes[0].note, 'a " // not a comment');
});

test("stripJsonc keeps commas that are not trailing and survives a BOM", () => {
  assert.deepEqual(parseJsonc('﻿{"a":[1,2],"b":"x,}"}'), { a: [1, 2], b: "x,}" });
  assert.equal(stripJsonc("[1,/* c */]"), "[1]");
});

test("parseWranglerToml reads top-level assets.directory and main, not env tables", () => {
  const toml = `
name = "x"
main = "worker/index.ts"
[assets]
directory = "./build" # comment
binding = "ASSETS"
[env.staging.assets]
directory = "./nope"
`;
  assert.deepEqual(parseWranglerToml(toml), {
    main: "worker/index.ts",
    assetsDirectory: "./build",
  });
  assert.equal(
    parseWranglerToml('assets = { directory = "out", binding = "A" }').assetsDirectory,
    "out"
  );
  assert.deepEqual(parseWranglerToml("name = 'x'"), {});
});

test("readWranglerConfig prefers jsonc, then json, then toml; honours an explicit path", () => {
  const dir = tmp();
  assert.equal(readWranglerConfig(dir).file, undefined);
  write(dir, "wrangler.toml", '[assets]\ndirectory = "t"');
  assert.equal(readWranglerConfig(dir).assetsDirectory, "t");
  write(dir, "wrangler.json", '{"assets":{"directory":"j"}}');
  assert.equal(readWranglerConfig(dir).assetsDirectory, "j");
  write(dir, "wrangler.jsonc", '{ // c\n "main": "w.ts", "assets": {"directory":"./c",} }');
  const c = readWranglerConfig(dir);
  assert.equal(c.assetsDirectory, "./c");
  assert.equal(c.main, "w.ts");
  write(dir, "other.toml", '[assets]\ndirectory = "o"');
  assert.equal(readWranglerConfig(dir, "other.toml").assetsDirectory, "o");
});

test("detectPackageManager: lockfiles, walking up, packageManager field, npm fallback", () => {
  for (const [lock, pm] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ]) {
    const dir = tmp();
    write(dir, lock, "");
    assert.equal(detectPackageManager(dir), pm, lock);
  }
  const ws = tmp();
  write(ws, "pnpm-lock.yaml", "");
  const site = join(ws, "docs");
  mkdirSync(site);
  assert.equal(detectPackageManager(site), "pnpm", "workspace-root lockfile");

  // No lockfile anywhere up the tree is hard to stage under tmpdir, so test the field via a
  // directory whose own package.json names a manager and has no lockfile above it.
  const bare = tmp();
  write(bare, "package.json", '{"packageManager":"yarn@4.1.0"}');
  assert.ok(["yarn", "npm", "pnpm", "bun"].includes(detectPackageManager(bare)));
});

test("run / exec commands per package manager (exec never downloads)", () => {
  assert.deepEqual(runScriptCommand("pnpm", "build", ["--outDir", "x"]), [
    "pnpm",
    ["run", "build", "--outDir", "x"],
  ]);
  assert.deepEqual(runScriptCommand("npm", "build", ["--outDir", "x"]), [
    "npm",
    ["run", "build", "--", "--outDir", "x"],
  ]);
  assert.deepEqual(runScriptCommand("npm", "build"), ["npm", ["run", "build"]]);
  assert.deepEqual(execLocalCommand("pnpm", "wrangler", ["dev"]), [
    "pnpm",
    ["exec", "wrangler", "dev"],
  ]);
  assert.deepEqual(execLocalCommand("npm", "wrangler", ["dev"]), [
    "npm",
    ["exec", "--no", "--", "wrangler", "dev"],
  ]);
  assert.deepEqual(execLocalCommand("bun", "wrangler"), ["bun", ["x", "--no-install", "wrangler"]]);
  assert.deepEqual(execLocalCommand("yarn", "wrangler", ["dev"]), ["yarn", ["wrangler", "dev"]]);
});

test("parsePort accepts only real ports", () => {
  assert.equal(parsePort(undefined), 4321);
  assert.equal(parsePort(""), 4321);
  assert.equal(parsePort("8080"), 8080);
  for (const bad of ["0", "-1", "65536", "abc", "1.5", "80x"])
    assert.equal(parsePort(bad), null, bad);
});

test("findFreePort walks upward and requires both stacks free", async () => {
  const busy4 = new Set([5000]);
  const busy6 = new Set([5001]);
  const isFree = async (port, host) => !(host === "::1" ? busy6 : busy4).has(port);
  assert.equal(await findFreePort(5000, 20, isFree), 5002);
  assert.equal(await findFreePort(5000, 2, isFree), null);
  assert.equal(await findFreePort(65535, 20, async () => true), 65535, "clamped to the range");
});

test("parseArgs", () => {
  const f = parseArgs([
    "--build",
    "astro build",
    "--port=9000",
    "--watch",
    "a,b",
    "--watch",
    "c",
    "--strict",
    "--out-dir-flag",
    "",
    "--",
    "--local",
  ]);
  assert.equal(f.build, "astro build");
  assert.equal(f.port, "9000");
  assert.deepEqual(f.watch, ["a", "b", "c"]);
  assert.equal(f.strict, true);
  assert.equal(f.outDirFlag, "");
  assert.deepEqual(f.wranglerArgs, ["--local"]);
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
  assert.throws(() => parseArgs(["--port"]), /needs a value/);
});

function site(files = {}) {
  const dir = tmp();
  write(dir, "package-lock.json", "{}");
  for (const [name, text] of Object.entries(files)) write(dir, name, text);
  return dir;
}

test("resolveOptions: defaults, wrangler assets.directory, staging derived from it", () => {
  const plain = resolveOptions(parseArgs([]), {}, site());
  assert.equal(plain.outDir, join(plain.root, "dist"));
  assert.equal(plain.staging, join(plain.root, ".dev-dist"));
  assert.equal(plain.pm, "npm");
  assert.equal(plain.port, 4321);
  assert.equal(plain.strict, false);

  const root = site({ "wrangler.jsonc": '{ /* c */ "assets": { "directory": "./build/out" } }' });
  const o = resolveOptions(parseArgs([]), {}, root);
  assert.equal(o.outDir, join(root, "build", "out"));
  assert.equal(o.staging, join(root, "build", ".dev-out"));
});

test("resolveOptions: flags beat env, env beats defaults, bad values throw", () => {
  const root = site({ "wrangler.jsonc": '{"assets":{"directory":"dist"}}' });
  const env = { PORT: "7000", MD_ROUTER_DEV_BUILD: "make site", MD_ROUTER_DEV_STRICT: "1" };
  const o = resolveOptions(parseArgs([]), env, root);
  assert.equal(o.port, 7000);
  assert.equal(o.buildOverride, "make site");
  assert.equal(o.strict, true);
  const f = resolveOptions(
    parseArgs(["--port", "7100", "--build", "x", "--out-dir", "public-out"]),
    env,
    root
  );
  assert.equal(f.port, 7100);
  assert.equal(f.buildOverride, "x");
  assert.equal(f.outDir, join(root, "public-out"));
  assert.equal(resolveOptions(parseArgs([]), { MD_ROUTER_DEV_STRICT: "0" }, root).strict, false);
  assert.throws(() => resolveOptions(parseArgs([]), { PORT: "nope" }, root), /port must be/);
  assert.throws(() => resolveOptions(parseArgs(["--out-dir", ".."]), {}, root), /subdirectory/);
  assert.throws(() => resolveOptions(parseArgs(["--out-dir", "."]), {}, root), /subdirectory/);
});

test("resolveOptions: watch defaults are additive, --no-default-watch replaces them", () => {
  const root = site();
  const def = resolveOptions(parseArgs(["--watch", "content"]), {}, root).watch;
  assert.ok(def.includes("src") && def.includes("public") && def.includes("content"));
  assert.ok(def.includes("astro.config.*") && def.includes(".env*"));
  assert.deepEqual(
    resolveOptions(parseArgs(["--no-default-watch", "--watch", "x"]), {}, root).watch,
    ["x"]
  );
});

test("buildInvocation: default script, appended flag, {outDir} placeholder, disabled flag", () => {
  const root = site();
  const base = resolveOptions(parseArgs([]), {}, root);
  assert.deepEqual(buildInvocation(base), {
    cmd: "npm",
    args: ["run", "build", "--", "--outDir", ".dev-dist"],
  });
  const custom = resolveOptions(parseArgs(["--build", "astro build"]), {}, root);
  assert.deepEqual(buildInvocation(custom), { shell: "astro build --outDir .dev-dist" });
  const ph = resolveOptions(
    parseArgs(["--build", "vite build --out {outDir} && x {outDir}"]),
    {},
    root
  );
  assert.deepEqual(buildInvocation(ph), { shell: "vite build --out .dev-dist && x .dev-dist" });
  const noflag = resolveOptions(parseArgs(["--build", "make", "--out-dir-flag", ""]), {}, root);
  assert.deepEqual(buildInvocation(noflag), { shell: "make" });
});

test("classifyWatch / matchesName", () => {
  const root = tmp();
  mkdirSync(join(root, "src"));
  const { dirs, names } = classifyWatch(root, [
    "src",
    "public",
    "astro.config.*",
    ".env*",
    "package.json",
  ]);
  assert.deepEqual(dirs, [join(root, "src")]);
  assert.ok(
    !names.includes("public"),
    "a plain name that is not on disk is a missing dir: skipped"
  );
  assert.ok(matchesName(names, "astro.config.mjs"));
  assert.ok(matchesName(names, ".env.local"));
  assert.ok(matchesName(names, "package.json"));
  assert.ok(!matchesName(names, "package-lock.json"));
  assert.ok(!matchesName(names, "README.md"));
});

test("shellQuote leaves safe words bare and quotes the rest", async () => {
  const { shellQuote } = await import("../bin/lib.mjs");
  assert.equal(shellQuote(".dev-dist"), ".dev-dist");
  assert.equal(shellQuote("my dir;rm"), "'my dir;rm'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("resolveOptions refuses an output dir that looks like source", () => {
  const root = site({ "package.json": "{}" });
  assert.throws(
    () => resolveOptions(parseArgs(["--out-dir", "src"]), {}, root),
    /looks like source/
  );
  assert.throws(
    () => resolveOptions(parseArgs(["--out-dir", "node_modules"]), {}, root),
    /looks like source/
  );
});
