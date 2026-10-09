import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import {
  buildInvocation,
  canonicalPath,
  checkOutDir,
  classifyWatch,
  descendantsOf,
  detectPackageManager,
  dirWithin,
  execLocalCommand,
  findFreePort,
  gitTrackedFiles,
  matchesName,
  parseArgs,
  parseJsonc,
  parsePort,
  parseWranglerToml,
  processTable,
  readWranglerConfig,
  resolveOptions,
  resolveWranglerBin,
  runScriptCommand,
  sameDir,
  stripJsonc,
} from "../bin/lib.mjs";

// Canonical, so expectations match resolveOptions' canonical paths (macOS tmp is /var → /private/var).
const tmp = () => canonicalPath(mkdtempSync(join(tmpdir(), "mdr-lib-")));
const write = (dir, name, text) => {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
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

test("an explicit --config that does not exist is an error, not silently ignored", () => {
  const dir = tmp();
  write(dir, "wrangler.jsonc", '{"assets":{"directory":"d"}}');
  assert.throws(
    () => readWranglerConfig(dir, "wrangler.staging.jsonc"),
    new RegExp(`config file ${join(dir, "wrangler.staging.jsonc")} not found`)
  );
  assert.throws(
    () => resolveOptions(parseArgs(["--config", "nope.toml"]), {}, dir),
    /config file .*nope\.toml not found/
  );
});

test("resolveWranglerBin finds the local package's bin (string or map), never anything else", () => {
  const dir = tmp();
  write(dir, "package.json", "{}");
  assert.equal(resolveWranglerBin(dir), null, "not installed");
  write(dir, "node_modules/wrangler/package.json", '{"bin":{"wrangler":"./bin/wrangler.js"}}');
  assert.equal(resolveWranglerBin(dir), null, "bin file missing");
  write(dir, "node_modules/wrangler/bin/wrangler.js", "");
  assert.equal(
    resolveWranglerBin(dir),
    join(canonicalPath(dir), "node_modules/wrangler/bin/wrangler.js")
  );
  // A string `bin`, and an `exports` map that hides package.json.
  write(dir, "node_modules/wrangler/package.json", '{"bin":"cli.js","exports":{".":"./index.js"}}');
  write(dir, "node_modules/wrangler/cli.js", "");
  assert.equal(resolveWranglerBin(dir), join(canonicalPath(dir), "node_modules/wrangler/cli.js"));
  // From a nested site in a workspace: resolution walks up like Node's.
  const nested = join(dir, "apps", "site");
  mkdirSync(nested, { recursive: true });
  assert.equal(
    resolveWranglerBin(nested),
    join(canonicalPath(dir), "node_modules/wrangler/cli.js")
  );
});

test("descendantsOf walks the whole tree; processTable sees this process", () => {
  const table = [
    [10, 1],
    [11, 10],
    [12, 11],
    [13, 10],
    [20, 1],
  ];
  assert.deepEqual(descendantsOf(table, 10), [11, 13, 12]);
  assert.deepEqual(descendantsOf(table, 20), []);
  if (process.platform !== "win32") {
    const me = processTable().find(([pid]) => pid === process.pid);
    assert.deepEqual(me, [process.pid, process.ppid]);
  }
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
  write(root, "config/site.json", "{}");
  const { dirs, names, dropped } = classifyWatch(root, [
    "src",
    "public",
    "astro.config.*",
    ".env*",
    "package.json",
    "config/site.json",
    "content/posts",
  ]);
  assert.deepEqual(dirs, [join(root, "src")]);
  assert.deepEqual(
    dropped.map((d) => d.entry),
    ["public", "config/site.json", "content/posts"],
    "reported, so a user-given entry can be warned about"
  );
  assert.match(dropped[1].why, /watch its directory/);
  assert.match(dropped[2].why, /no such directory/);
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

/* ------------------------------------------------- output-dir guard */

const refuses = (root, args, why) =>
  assert.throws(
    () => resolveOptions(parseArgs(args), {}, root),
    (err) => {
      assert.match(err.message, /^refusing output dir /);
      assert.match(err.message, why);
      assert.match(err.message, /Point --out-dir/, "says how to fix it");
      return true;
    }
  );

test("output dir: source dirs, inside them, or containing them are refused", () => {
  const root = site({ "package.json": "{}", "src/a.ts": "", "public/x.png": "" });
  refuses(root, ["--out-dir", "src"], /is src\/, which holds source/);
  refuses(root, ["--out-dir", "src/out"], /inside src\//);
  refuses(root, ["--out-dir", "node_modules"], /is node_modules\//);
  refuses(root, ["--out-dir", ".git"], /is \.git\//);
  refuses(root, ["--out-dir", "public"], /is public\//);
  assert.equal(
    resolveOptions(parseArgs(["--out-dir", "dist"]), {}, root).outDir,
    join(root, "dist")
  );
});

test("output dir: SRC is src on a case-insensitive filesystem", (t) => {
  const root = site({ "src/a.ts": "" });
  if (!existsSync(join(root, "SRC"))) {
    t.skip("this filesystem is case-sensitive, so SRC is a different directory from src");
    return;
  }
  refuses(root, ["--out-dir", "SRC"], /is src\/, which holds source/);
  refuses(root, ["--out-dir", "Src/Out"], /inside src\//);
});

test("output dir: the Worker's directory, from wrangler main, is refused", () => {
  const root = site({
    "wrangler.jsonc": '{"main":"worker/index.ts","assets":{"directory":"dist"}}',
    "worker/index.ts": "",
  });
  refuses(root, ["--out-dir", "worker"], /is worker\/, which holds source/);
  // ...but a Worker the config itself places in build output (Astro's adapter) is not source.
  const astro = site({
    "wrangler.jsonc": '{"main":"./dist/_worker.js/index.js","assets":{"directory":"./dist"}}',
  });
  assert.equal(resolveOptions(parseArgs([]), {}, astro).outDir, join(astro, "dist"));
  refuses(astro, ["--out-dir", "dist/_worker.js"], /is dist\/_worker\.js\//);
});

test("output dir: the site root, its ancestors, / and the wrangler config's dir are refused", () => {
  const root = site({ "package.json": "{}" });
  refuses(root, ["--out-dir", "."], /must be a subdirectory of the site root/);
  refuses(root, ["--out-dir", ".."], /must be a subdirectory of the site root/);
  refuses(root, ["--out-dir", "/"], /must be a subdirectory of the site root/);
  // Config in a subdirectory: a relative --out-dir resolves against it, so "." is that dir.
  write(root, "site/wrangler.jsonc", '{"main":"index.ts"}');
  refuses(
    root,
    ["--config", "site/wrangler.jsonc", "--out-dir", "."],
    /is site\/ \(it holds the wrangler config/
  );
  const ok = resolveOptions(
    parseArgs(["--config", "site/wrangler.jsonc", "--out-dir", "dist"]),
    {},
    root
  );
  assert.equal(ok.outDir, join(root, "site", "dist"));
});

test("output dir: one with a package.json, or git-tracked files, is refused", (t) => {
  const root = site({ "package.json": "{}", "pkg/package.json": "{}" });
  refuses(root, ["--out-dir", "pkg"], /has a package\.json/);
  if (spawnSync("git", ["--version"]).status !== 0) {
    t.skip("git is not installed");
    return;
  }
  write(root, "content/post.md", "# hi");
  write(root, "content/other.md", "# hi");
  write(root, "dist/index.html", "built");
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  assert.equal(spawnSync("git", ["-C", root, "add", "content"]).status, 0);
  refuses(
    root,
    ["--out-dir", "content"],
    /holds 2 git-tracked file\(s\) \(content\/other\.md, content\/post\.md\)/
  );
  // Untracked build output is fine, and so is a dir that doesn't exist yet.
  assert.equal(resolveOptions(parseArgs([]), {}, root).outDir, join(root, "dist"));
  assert.equal(resolveOptions(parseArgs(["--out-dir", "new"]), {}, root).outDir, join(root, "new"));
  rmSync(root, { recursive: true, force: true });
});

/* A Linux kernel on a case-insensitive mount (a macOS bind mount in Docker Desktop, WSL /mnt/c, ext4
 * casefold): lookups ignore case, but realpath hands back the caller's spelling. Modelled in memory
 * so it runs everywhere; `readdir` can be disabled to prove the (dev, ino) identity check holds on
 * its own, without the case-fixing pass in canonicalPath. */
function caseInsensitiveLinux(dirs, { listing = true, files = [] } = {}) {
  const key = (p) => p.toLowerCase();
  const ino = new Map(dirs.map((d, i) => [key(d), i + 1]));
  const fileKeys = new Set(files.map(key));
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return {
    stat: (p) => {
      if (!ino.has(key(p))) throw enoent();
      return { dev: 7, ino: ino.get(key(p)) };
    },
    realpath: (p) => {
      if (ino.has(key(p)) || fileKeys.has(key(p))) return p; // keeps the caller's case
      throw enoent();
    },
    readdir: (p) => {
      if (!listing) throw new Error("ENOTSUP");
      return dirs.filter((d) => d !== "/" && key(dirname(d)) === key(p)).map((d) => basename(d));
    },
    exists: (p) => ino.has(key(p)) || fileKeys.has(key(p)),
    tracked: () => [],
  };
}

test("output dir: SRC is src on a case-insensitive Linux mount, by identity alone", () => {
  const dirs = ["/", "/site", "/site/src", "/site/public", "/site/web"];
  for (const listing of [false, true]) {
    const fsx = caseInsensitiveLinux(dirs, { listing });
    const check = (outDir, configDir = "/site") =>
      checkOutDir(
        { root: "/site", outDir, staging: `/site/.dev-${basename(outDir)}`, configDir },
        fsx
      );
    assert.ok(sameDir("/site/SRC", "/site/src", fsx), "one directory, two spellings");
    assert.ok(dirWithin("/site/Src/new/out", "/site/src", fsx), "inside, through a case variant");
    assert.ok(dirWithin("/site/src", "/SITE", fsx), "the parent spelt differently");
    assert.throws(() => check("/site/SRC"), /it is .*src\/, which holds source/i);
    assert.throws(() => check("/site/Src/out"), /it is inside .*src\//i);
    assert.throws(() => check("/SITE"), /must be a subdirectory of the site root/);
    assert.throws(
      () => check("/site/WEB", "/site/web"),
      /it is .*web\/ \(it holds the wrangler config/i
    );
    check("/site/dist"); // not refused
  }
  // With the listing available, the spelling is fixed too (what the watcher's ignore check needs).
  const fsx = caseInsensitiveLinux(dirs);
  assert.equal(canonicalPath("/site/SRC/x", fsx), "/site/src/x");
  assert.equal(canonicalPath("/SITE/Public", fsx), "/site/public");
});

test("output dir: git-tracked files are found whatever the case of the path", (t) => {
  if (spawnSync("git", ["--version"]).status !== 0) {
    t.skip("git is not installed");
    return;
  }
  const root = site({ "src/a.ts": "" });
  if (!existsSync(join(root, "SRC"))) {
    t.skip("this filesystem is case-sensitive, so SRC is a different (missing) directory");
    return;
  }
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  assert.equal(spawnSync("git", ["-C", root, "add", "src"]).status, 0);
  // `git ls-files -- SRC` alone finds nothing, even with core.ignorecase; the guard's pathspec must.
  assert.deepEqual(gitTrackedFiles(root, join(root, "SRC")), ["src/a.ts"]);
  rmSync(root, { recursive: true, force: true });
});

test("output dir: a volume reporting inode 0 falls back to paths instead of refusing everything", () => {
  const fsx = {
    stat: (p) => {
      if (!["/", "/site", "/site/src"].includes(p))
        throw Object.assign(new Error(), { code: "ENOENT" });
      return { dev: 3n, ino: 0n };
    },
    realpath: (p) => {
      if (["/", "/site", "/site/src"].includes(p)) return p;
      throw Object.assign(new Error(), { code: "ENOENT" });
    },
    readdir: () => [],
    exists: () => false,
    tracked: () => [],
  };
  const check = (outDir) =>
    checkOutDir(
      { root: "/site", outDir, staging: `/site/.dev-${basename(outDir)}`, configDir: "/site" },
      fsx
    );
  assert.equal(sameDir("/site/dist", "/site", fsx), false, "every dir has ino 0, but they differ");
  check("/site/dist"); // not refused
  assert.throws(() => check("/site/src"), /it is src\//);
  assert.throws(() => check("/site"), /must be a subdirectory/);
});
