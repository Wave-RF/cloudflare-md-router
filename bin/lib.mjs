/* Pure helpers for `cloudflare-md-router dev` (see bin/dev.mjs). Node built-ins only, plain JS so
 * the CLI runs under any Node >=20 without a build step. Nothing here is imported by the Worker
 * (`src/` never references `bin/`), so none of it can reach a Worker bundle. */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export const DEFAULT_PORT = 4321;
export const MAX_PORT = 65535;
export const PORT_TRIES = 20;
export const DEFAULT_OUT_DIR = "dist";
export const DEFAULT_OUT_DIR_FLAG = "--outDir";
export const DEFAULT_WATCH = ["src", "public"];
/** Root-level build inputs watched by default (exact names; `*` allowed only as a suffix). */
export const DEFAULT_ROOT_TRIGGERS = [
  "astro.config.*",
  "vite.config.*",
  "tsconfig.json",
  "package.json",
  ".env*",
];

/* ---------------------------------------------------------------- JSONC */

/** Strip `//` and block comments and trailing commas from JSONC, leaving string contents alone. */
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && next === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas: a comma followed (after whitespace) by } or ], outside strings.
  let res = "";
  for (let k = 0; k < out.length; k++) {
    const c = out[k];
    if (c === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      res += out.slice(k, j + 1);
      k = j;
    } else if (c === ",") {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] !== "}" && out[j] !== "]") res += c;
    } else {
      res += c;
    }
  }
  return res;
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text.replace(/^﻿/, "")));
}

/** Quote one shell word (POSIX single quotes; left bare when plainly safe, or on Windows). */
export function shellQuote(word) {
  if (/^[\w@%+=:,./-]+$/.test(word) || process.platform === "win32") return word;
  return `'${word.replace(/'/g, "'\\''")}'`;
}

/* ----------------------------------------------------------------- TOML */

/** Pull `assets.directory` and `main` out of a wrangler.toml — only the top-level (non-env) ones.
 * Deliberately not a TOML parser: it understands `[assets]` tables and `assets = { … }` inline. */
export function parseWranglerToml(text) {
  const result = {};
  let table = "";
  const str = String.raw`(?:"((?:[^"\\]|\\.)*)"|'([^']*)')`;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, "");
    const header = line.match(/^\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/);
    if (header && !line.startsWith("[[")) {
      table = header[1];
      continue;
    }
    if (line.startsWith("[[")) {
      table = "[[array]]";
      continue;
    }
    if (table === "") {
      const main = line.match(new RegExp(`^main\\s*=\\s*${str}`));
      if (main) result.main = main[1] ?? main[2];
      const inline = line.match(new RegExp(`^assets\\s*=\\s*\\{[^}]*?\\bdirectory\\s*=\\s*${str}`));
      if (inline) result.assetsDirectory = inline[1] ?? inline[2];
    } else if (table === "assets") {
      const dir = line.match(new RegExp(`^directory\\s*=\\s*${str}`));
      if (dir) result.assetsDirectory = dir[1] ?? dir[2];
    }
  }
  return result;
}

/** Find and read the wrangler config. Returns `{ file, assetsDirectory, main }` (each may be undefined). */
export function readWranglerConfig(root, explicit) {
  if (explicit && !existsSync(resolve(root, explicit))) {
    throw new Error(`config file ${resolve(root, explicit)} not found`);
  }
  const candidates = explicit
    ? [resolve(root, explicit)]
    : ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].map((f) => join(root, f));
  const file = candidates.find((f) => existsSync(f));
  if (!file) return { file: undefined };
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".toml")) return { file, ...parseWranglerToml(text) };
  let json;
  try {
    json = parseJsonc(text);
  } catch (err) {
    throw new Error(`could not parse ${file}: ${err.message}`);
  }
  const assets = json.assets;
  return {
    file,
    main: typeof json.main === "string" ? json.main : undefined,
    assetsDirectory: assets && typeof assets.directory === "string" ? assets.directory : undefined,
  };
}

/* ------------------------------------------------------ package manager */

const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/** Lockfile → package manager, walking up from `root` (monorepo sites keep the lockfile at the
 * workspace root). Falls back to package.json `packageManager`, then npm. */
export function detectPackageManager(root) {
  let dir = resolve(root);
  for (;;) {
    for (const [file, pm] of LOCKFILES) if (existsSync(join(dir, file))) return pm;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const m = /^(pnpm|yarn|npm|bun)@/.exec(pkg.packageManager ?? "");
    if (m) return m[1];
  } catch {}
  return "npm";
}

/** `[command, args]` that runs a package.json script. Extra args are forwarded to the script. */
export function runScriptCommand(pm, script, extra = []) {
  if (pm === "npm") return ["npm", ["run", script, ...(extra.length ? ["--", ...extra] : [])]];
  return [pm, ["run", script, ...extra]];
}

/** `[command, args]` that runs a locally-installed binary and NEVER downloads it. */
export function execLocalCommand(pm, bin, args = []) {
  switch (pm) {
    case "pnpm":
      return ["pnpm", ["exec", bin, ...args]];
    case "yarn":
      return ["yarn", [bin, ...args]]; // yarn classic and berry both run local bins
    case "bun":
      return ["bun", ["x", "--no-install", bin, ...args]];
    default:
      return ["npm", ["exec", "--no", "--", bin, ...args]];
  }
}

/** The JS entry of the site's locally-installed wrangler (its package.json `bin.wrangler`), or
 * null if it can't be resolved — not installed, or a Yarn PnP install. Resolution only looks at
 * what is on disk, so this never downloads anything. Running this file with `process.execPath`
 * puts no package manager or shell between us and wrangler, so our signals reach it. */
export function resolveWranglerBin(root) {
  const req = createRequire(join(root, "package.json"));
  let pkgFile;
  try {
    pkgFile = req.resolve("wrangler/package.json");
  } catch {
    // A package whose `exports` hides package.json still has one on disk: look in the same dirs.
    pkgFile = (req.resolve.paths("wrangler") ?? [])
      .map((dir) => join(dir, "wrangler", "package.json"))
      .find((f) => existsSync(f));
  }
  if (!pkgFile) return null;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  } catch {
    return null;
  }
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.wrangler;
  if (typeof rel !== "string") return null;
  const file = resolve(dirname(pkgFile), rel);
  return existsSync(file) ? file : null;
}

/* ------------------------------------------------------------- processes */

/** `[pid, ppid]` for every process we can see: /proc on Linux (always there, even in slim
 * containers without `ps`), `ps` elsewhere on POSIX. Empty on Windows or on any failure. */
export function processTable() {
  try {
    if (process.platform === "linux") {
      const rows = [];
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const stat = readFileSync(`/proc/${name}/stat`, "utf8");
          // Fields after the `(comm)`, which may itself contain spaces and parens: state ppid …
          const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
          rows.push([Number(name), ppid]);
        } catch {} // exited while we were reading
      }
      return rows;
    }
    if (process.platform === "win32") return [];
    const out = execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((r) => r.length === 2 && r.every(Number.isInteger));
  } catch {
    return [];
  }
}

/** Every descendant of `pid` in a `[pid, ppid]` table (children first, then theirs). */
export function descendantsOf(table, pid) {
  const found = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const [p, pp] of table) {
      if (pp === parent && p !== pid && !found.includes(p)) {
        found.push(p);
        queue.push(p);
      }
    }
  }
  return found;
}

/** Is `pid` (or, negative, process group `-pid`) still around? EPERM means it exists. */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/* ----------------------------------------------------------------- port */

/** A real TCP port, or null. "" / "0" / non-numeric / out of range are all rejected, because they
 * would otherwise bind an ephemeral port or throw from inside the probe. */
export function parsePort(raw) {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) return null;
  return port;
}

export const lastPortFor = (start, tries) => Math.min(start + tries - 1, MAX_PORT);

/** Bind errors that mean "this host has no usable IPv6", not "the port is taken". */
const IPV6_UNAVAILABLE = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT", "EPROTONOSUPPORT"]);

export function portFree(port, host) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", (err) => done(host === "::1" && IPV6_UNAVAILABLE.has(err.code)));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => done(true)));
  });
}

/** First port in `[start, start+tries)` free on BOTH IPv4 and IPv6 loopback (wrangler binds both,
 * and a squatter such as an `astro dev` elsewhere often holds only `::1`). */
export async function findFreePort(start, tries = PORT_TRIES, isFree = portFree) {
  for (let port = start, last = lastPortFor(start, tries); port <= last; port++) {
    if ((await isFree(port, "127.0.0.1")) && (await isFree(port, "::1"))) return port;
  }
  return null;
}

/* -------------------------------------------------------- output guard */

/** The filesystem calls the guard makes, injectable so a test can model a filesystem this machine
 * doesn't have (a case-insensitive mount on Linux, where `realpath` keeps the caller's case). */
export const REAL_FS = {
  stat: (p) => statSync(p),
  realpath: (p) => realpathSync.native(p),
  readdir: (p) => readdirSync(p),
  exists: (p) => existsSync(p),
  tracked: (root, dir) => gitTrackedFiles(root, dir),
};

/** The path as the filesystem spells it: symlinks resolved, then each existing segment matched
 * against its parent's listing, so `SRC` becomes `src` on a case-insensitive volume even where
 * `realpath` keeps the input's case (Linux on a macOS bind mount, WSL `/mnt/c`, ext4 casefold). A
 * path that doesn't exist yet is canonicalised through its nearest existing ancestor. */
export function canonicalPath(p, fsx = REAL_FS) {
  const abs = resolve(p);
  const rest = [];
  let real;
  for (let dir = abs; ; dir = dirname(dir)) {
    try {
      real = fsx.realpath(dir);
      break;
    } catch {}
    if (dirname(dir) === dir) return abs;
    rest.unshift(basename(dir));
  }
  const top = parse(real).root;
  let fixed = top;
  for (const seg of real.slice(top.length).split(sep).filter(Boolean)) {
    let name = seg;
    try {
      const entries = fsx.readdir(fixed);
      if (!entries.includes(seg)) {
        const lower = seg.toLowerCase();
        const hits = entries.filter((e) => e.toLowerCase() === lower);
        if (hits.length === 1) name = hits[0];
      }
    } catch {}
    fixed = join(fixed, name);
  }
  return join(fixed, ...rest);
}

/** Is `child` the same path as `parent`, or inside it? Both must already be canonical. */
export function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** `dev:ino` of a directory, or null if it doesn't exist. */
function dirId(p, fsx) {
  try {
    const st = fsx.stat(p);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/** Directory identity, not spelling: is `child` the same directory as `parent`, or inside it? The
 * child's existing ancestors (itself included) are compared to the parent by (dev, ino), so two
 * spellings of one directory — case variants, bind aliases — can't slip past. Where the parent
 * doesn't exist yet there is nothing to identify, so canonical paths are compared instead. */
export function dirWithin(child, parent, fsx = REAL_FS) {
  const c = canonicalPath(child, fsx);
  const p = canonicalPath(parent, fsx);
  const pid = dirId(p, fsx);
  if (pid === null) return isWithin(c, p);
  for (let d = c; ; d = dirname(d)) {
    if (dirId(d, fsx) === pid) return true;
    if (dirname(d) === d) return false;
  }
}

/** Same directory, by identity when both exist. */
export function sameDir(a, b, fsx = REAL_FS) {
  const ia = dirId(a, fsx);
  const ib = dirId(b, fsx);
  if (ia !== null && ib !== null) return ia === ib;
  return canonicalPath(a, fsx) === canonicalPath(b, fsx);
}

/** Git-tracked files under `dir`, relative to `root` (empty if not in a git work tree or no git).
 * The pathspec is case-insensitive: git's own matching is case-sensitive even with
 * core.ignorecase, and over-matching only makes the guard stricter. */
export function gitTrackedFiles(root, dir) {
  if (!existsSync(dir)) return [];
  try {
    const spec = `:(icase,literal)${relative(root, dir)}`;
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--", spec], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/** Refuse an output directory whose pruning would delete something that isn't build output. The
 * loop makes `outDir` match each build exactly (and empties `staging` before each), so anything
 * else in them is deleted. Throws a user-facing Error that says why and what to pass instead.
 *
 * Directories are compared by identity (see `dirWithin`), so `SRC`, a symlink or a bind alias
 * can't slip past. The rules:
 * - outDir must be strictly inside the site root (not the root, nor anywhere outside it);
 * - it must not be, be inside, or enclose src/, public/, node_modules/ or .git/;
 * - it must not be, or enclose, the wrangler config's directory;
 * - the wrangler `main`'s directory (`workerDir`): if it is the root or config dir or above them,
 *   outDir must not be it or enclose it (already implied by the two rules above); if it lies inside
 *   the wrangler-configured assets directory, the config itself declares the Worker to be build
 *   output (Astro's adapter writes `dist/_worker.js`), so only an outDir equal to it or inside it is
 *   refused; anywhere else it is source, like src/;
 * - outDir and staging must not hold a package.json or any git-tracked file. */
export function checkOutDir(
  { root, outDir, staging, configDir, workerDir, assetsDir, given },
  fsx = REAL_FS
) {
  const fix =
    "Point --out-dir (or assets.directory in the wrangler config) at a directory only the build " +
    "writes, such as dist/.";
  const pruned = "it is emptied and refilled to match every build";
  const rootC = canonicalPath(root, fsx);
  const show = (p) => {
    const c = canonicalPath(p, fsx);
    return sameDir(c, rootC, fsx) ? ". (the site root)" : `${relative(rootC, c)}/`;
  };
  const refuse = (msg) => {
    const name = given && resolve(configDir, given) !== outDir ? `${given} (${outDir})` : outDir;
    throw new Error(`refusing output dir ${name}: ${msg}. ${fix}`);
  };
  const within = (a, b) => dirWithin(a, b, fsx);

  if (sameDir(outDir, rootC, fsx) || !within(outDir, rootC)) {
    refuse(`it must be a subdirectory of the site root ${root}, because ${pruned}`);
  }
  const leaves = ["src", "public", "node_modules", ".git"].map((d) => join(rootC, d));
  const containers = [configDir];
  if (workerDir) {
    if (within(rootC, workerDir) || within(configDir, workerDir)) containers.push(workerDir);
    else if (assetsDir && within(workerDir, assetsDir)) {
      if (within(outDir, workerDir)) leaves.push(workerDir);
    } else leaves.push(workerDir);
  }
  for (const d of leaves) {
    if (within(outDir, d)) {
      const how = sameDir(outDir, d, fsx) ? "" : "inside ";
      refuse(`it is ${how}${show(d)}, which holds source, and ${pruned}`);
    }
    if (within(d, outDir)) refuse(`it contains ${show(d)}, which holds source, and ${pruned}`);
  }
  for (const d of containers) {
    if (within(d, outDir)) {
      const how = sameDir(outDir, d, fsx) ? "is" : "contains";
      refuse(`it ${how} ${show(d)} (it holds the wrangler config or Worker), and ${pruned}`);
    }
  }
  for (const dir of [outDir, staging]) {
    const d = canonicalPath(dir, fsx);
    if (fsx.exists(join(d, "package.json"))) {
      refuse(
        `${show(d)} has a package.json, so it looks like a package, not build output, and ${pruned}`
      );
    }
    const tracked = fsx.tracked(rootC, d);
    if (tracked.length > 0) {
      const sample = tracked.slice(0, 3).join(", ") + (tracked.length > 3 ? ", …" : "");
      refuse(
        `${show(d)} holds ${tracked.length} git-tracked file(s) (${sample}), and ${pruned}, so they ` +
          `would be deleted. Build output is normally gitignored; if these really are build ` +
          `output, untrack them (git rm -r --cached ${relative(rootC, d)})`
      );
    }
  }
}

/* ------------------------------------------------------------ CLI args */

export const HELP = `cloudflare-md-router dev — production-faithful dev loop for a Worker + static assets site

Usage: cloudflare-md-router dev [options] [-- <extra wrangler dev args>]

  --build <cmd>        build command (default: the site's "build" script via its package manager).
                       Run through the shell with node_modules/.bin on PATH, so "astro build" works.
  --out-dir <dir>      served output dir (default: assets.directory from the wrangler config, else dist);
                       a relative path resolves against the wrangler config's directory. Emptied and
                       refilled on every build, so the site root, anything outside it, source dirs
                       (src, public, node_modules, .git, the Worker's), the config's dir, and a dir
                       with a package.json or git-tracked files are refused.
  --out-dir-flag <f>   flag used to point the build at the staging dir (default: ${DEFAULT_OUT_DIR_FLAG};
                       use "" to disable). Ignored if --build contains {outDir}.
  --watch <path>       extra path to rebuild on, repeatable or comma-separated, added to the defaults
                       (src, public, astro/vite config, tsconfig.json, package.json, .env*).
                       Directories recurse; anything else is a root-level file name (a trailing *
                       is a prefix match); nested file paths and missing dirs are skipped, with a
                       warning. The Worker dir is NOT watched: wrangler reloads it itself. Never
                       triggering: the output and staging dirs, node_modules, .git, .wrangler,
                       framework caches (.astro, .svelte-kit, .next, …) and anything gitignored.
  --no-default-watch   watch only what --watch names
  --port <n>           first port to try (default: $PORT, else ${DEFAULT_PORT}); walks up to ${PORT_TRIES - 1} higher
  --config <file>      wrangler config (default: wrangler.jsonc, wrangler.json, wrangler.toml); must exist
  --root <dir>         site root (default: cwd)
  --strict             do not set MD_ROUTER_DEV=1 for the build (keep strict checks on)
  --help, -h

Env: PORT, MD_ROUTER_DEV_BUILD, MD_ROUTER_DEV_STRICT=1. Flags win over env.
The build sees MD_ROUTER_DEV=1 (unless strict) and MD_ROUTER_DEV_OUT_DIR=<staging dir>.`;

const VALUE_FLAGS = new Set([
  "--build",
  "--out-dir",
  "--out-dir-flag",
  "--watch",
  "--port",
  "--config",
  "--root",
]);

/** argv (after the `dev` subcommand) → raw flags. Throws a user-facing Error on bad input. */
export function parseArgs(argv) {
  const flags = { watch: [], wranglerArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "--") {
      flags.wranglerArgs = argv.slice(i + 1);
      break;
    }
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--strict") flags.strict = true;
    else if (arg === "--no-default-watch") flags.noDefaultWatch = true;
    else {
      let value;
      const eq = arg.indexOf("=");
      if (arg.startsWith("--") && eq !== -1) {
        value = arg.slice(eq + 1);
        arg = arg.slice(0, eq);
      }
      if (!VALUE_FLAGS.has(arg)) throw new Error(`unknown option ${arg} (try --help)`);
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new Error(`${arg} needs a value`);
      }
      if (arg === "--watch") {
        flags.watch.push(...value.split(",").filter(Boolean));
      } else flags[arg.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
    }
  }
  return flags;
}

const truthy = (v) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

/** Flags + env + the site on disk → everything the loop needs. Throws on invalid input. */
export function resolveOptions(flags, env, cwd) {
  const root = resolve(cwd, flags.root ?? ".");
  const wrangler = readWranglerConfig(root, flags.config);

  const port = parsePort(flags.port ?? env.PORT);
  if (port === null) {
    throw new Error(
      `port must be an integer 1-${MAX_PORT}, got ${JSON.stringify(flags.port ?? env.PORT)}`
    );
  }

  const outDirRaw = flags.outDir ?? wrangler.assetsDirectory ?? DEFAULT_OUT_DIR;
  const configDir = wrangler.file ? dirname(wrangler.file) : root;
  // Canonical (on-disk case, symlinks resolved), so the watcher's ignore check — which compares
  // against paths built from what the filesystem reports — matches whatever spelling was passed.
  const outDir = canonicalPath(resolve(configDir, outDirRaw));
  const staging = join(dirname(outDir), `.dev-${basename(outDir)}`);
  checkOutDir({
    given: outDirRaw,
    root,
    outDir,
    staging,
    configDir,
    workerDir: wrangler.main ? dirname(resolve(configDir, wrangler.main)) : undefined,
    assetsDir: wrangler.assetsDirectory ? resolve(configDir, wrangler.assetsDirectory) : undefined,
  });

  const watch = [
    ...(flags.noDefaultWatch ? [] : [...DEFAULT_WATCH, ...DEFAULT_ROOT_TRIGGERS]),
    ...flags.watch,
  ];

  const pm = detectPackageManager(root);
  const buildOverride = flags.build ?? (env.MD_ROUTER_DEV_BUILD || undefined);

  return {
    root: canonicalPath(root),
    port,
    pm,
    outDir,
    staging,
    wranglerConfig: wrangler.file,
    watch,
    userWatch: flags.watch,
    outDirFlag: flags.outDirFlag ?? DEFAULT_OUT_DIR_FLAG,
    buildOverride,
    strict: flags.strict === true || truthy(env.MD_ROUTER_DEV_STRICT),
    wranglerArgs: flags.wranglerArgs,
  };
}

/** The build invocation: `{ shell: string }` for a custom command, `{ cmd, args }` for the default. */
export function buildInvocation(opts) {
  const stagingRel = relative(opts.root, opts.staging) || opts.staging;
  if (opts.buildOverride) {
    let command = opts.buildOverride;
    if (command.includes("{outDir}")) {
      command = command.split("{outDir}").join(shellQuote(stagingRel));
    } else if (opts.outDirFlag) {
      command = `${command} ${shellQuote(opts.outDirFlag)} ${shellQuote(stagingRel)}`;
    }
    return { shell: command };
  }
  const extra = opts.outDirFlag ? [opts.outDirFlag, stagingRel] : [];
  const [cmd, args] = runScriptCommand(opts.pm, "build", extra);
  return { cmd, args };
}

/** Directories to watch recursively, and root-level file names (`*` suffix = prefix match) to
 * match in the root directory. Entries that can't be watched land in `dropped` with the reason, so
 * the caller can say so for the ones the user asked for (a default like `public` is just absent). */
export function classifyWatch(root, entries) {
  const dirs = [];
  const names = [];
  const dropped = [];
  for (const entry of entries) {
    const abs = isAbsolute(entry) ? entry : join(root, entry);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {}
    if (isDir) dirs.push(abs);
    else if (entry.includes("/") || entry.includes(sep)) {
      dropped.push({
        entry,
        why: existsSync(abs)
          ? "only directories and root-level file names can be watched; watch its directory"
          : "no such directory",
      });
    }
    // A plain name with no dot or `*` that isn't on disk is a directory that doesn't exist (yet),
    // e.g. a site with no `public/`. Skip it; `.env` and `*.config.*` style names are kept.
    else if (entry.includes("*") || entry.includes(".") || existsSync(abs)) names.push(entry);
    else dropped.push({ entry, why: "no such directory" });
  }
  return { dirs, names, dropped };
}

/** Does a root-level file name match a watch name (exact, or prefix when it ends in `*`, which
 * covers `.env*` and `astro.config.*`)? */
export function matchesName(names, file) {
  return names.some((n) => {
    if (n.endsWith("*")) return file.startsWith(n.slice(0, -1));
    return n === file;
  });
}

/** Editor droppings: macOS Finder, vim swap/backup files, vim's fsync probe. */
export const IGNORED = /(^|\/)(\.DS_Store|4913|.*\.sw[px]|.*~)$/;
