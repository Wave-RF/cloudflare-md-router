/* Pure helpers for `cloudflare-md-router dev` (see bin/dev.mjs). Node built-ins only, plain JS so
 * the CLI runs under any Node >=20 without a build step. Nothing here is imported by the Worker
 * (`src/` never references `bin/`), so none of it can reach a Worker bundle. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

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
  const candidates = explicit
    ? [resolve(root, explicit)]
    : ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].map((f) => join(root, f));
  const file = candidates.find((f) => existsSync(f));
  if (!file) return { file: undefined };
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".toml")) return { file, ...parseWranglerToml(text) };
  const json = parseJsonc(text);
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

/* ------------------------------------------------------------ CLI args */

export const HELP = `cloudflare-md-router dev — production-faithful dev loop for a Worker + static assets site

Usage: cloudflare-md-router dev [options] [-- <extra wrangler dev args>]

  --build <cmd>        build command (default: the site's "build" script via its package manager).
                       Run through the shell with node_modules/.bin on PATH, so "astro build" works.
  --out-dir <dir>      served output dir (default: assets.directory from the wrangler config, else dist)
  --out-dir-flag <f>   flag used to point the build at the staging dir (default: ${DEFAULT_OUT_DIR_FLAG};
                       use "" to disable). Ignored if --build contains {outDir}.
  --watch <path>       extra path to rebuild on, repeatable or comma-separated, added to the defaults
                       (src, public, astro/vite config, tsconfig.json, package.json, .env*).
                       Directories recurse; anything else is a root-level file name (a trailing *
                       is a prefix match). The Worker dir is NOT watched: wrangler reloads it itself.
  --no-default-watch   watch only what --watch names
  --port <n>           first port to try (default: $PORT, else ${DEFAULT_PORT}); walks up to ${PORT_TRIES - 1} higher
  --config <file>      wrangler config (default: wrangler.jsonc, wrangler.json, wrangler.toml)
  --root <dir>         site root (default: cwd)
  --strict             do not set MD_ROUTER_DEV=1 for the build (keep strict checks on)
  --help

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
  const outDir = resolve(wrangler.file ? dirname(wrangler.file) : root, outDirRaw);
  if (relative(root, outDir) === "" || relative(root, outDir).startsWith("..")) {
    throw new Error(`output dir ${outDir} must be a subdirectory of the site root ${root}`);
  }
  const staging = join(dirname(outDir), `.dev-${basename(outDir)}`);

  const watch = [
    ...(flags.noDefaultWatch ? [] : [...DEFAULT_WATCH, ...DEFAULT_ROOT_TRIGGERS]),
    ...flags.watch,
  ];

  const pm = detectPackageManager(root);
  const buildOverride = flags.build ?? (env.MD_ROUTER_DEV_BUILD || undefined);

  return {
    root,
    port,
    pm,
    outDir,
    staging,
    wranglerConfig: wrangler.file,
    workerMain: wrangler.main,
    watch,
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
    if (command.includes("{outDir}")) command = command.split("{outDir}").join(stagingRel);
    else if (opts.outDirFlag) command = `${command} ${opts.outDirFlag} ${stagingRel}`;
    return { shell: command };
  }
  const extra = opts.outDirFlag ? [opts.outDirFlag, stagingRel] : [];
  const [cmd, args] = runScriptCommand(opts.pm, "build", extra);
  return { cmd, args };
}

/** Directories to watch recursively, and root-level file names (`*` suffix = prefix match) to
 * match in the root directory. A missing directory is skipped by the caller, not an error here. */
export function classifyWatch(root, entries) {
  const dirs = [];
  const names = [];
  for (const entry of entries) {
    const abs = isAbsolute(entry) ? entry : join(root, entry);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {}
    if (isDir) dirs.push(abs);
    else if (entry.includes("/"))
      continue; // nested files aren't supported; pass the directory
    // A plain name with no dot or `*` that isn't on disk is a directory that doesn't exist (yet),
    // e.g. a site with no `public/`. Skip it; `.env` and `*.config.*` style names are kept.
    else if (entry.includes("*") || entry.includes(".") || existsSync(abs)) names.push(entry);
  }
  return { dirs, names };
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
