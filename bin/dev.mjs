/* `cloudflare-md-router dev` — a production-faithful dev loop for a site that runs a Cloudflare
 * Worker in front of static assets.
 *
 * Why not the framework's dev server (`astro dev`, `vite`, …)? It skips everything the Worker adds
 * in production — content negotiation for `.md` twins, any outputs only a real build produces. So
 * this runs a full build on every save into a staging directory and swaps it into the served output
 * directory only when the build succeeded; `wrangler dev --live-reload` serves that directory.
 * A failed build (or the emptied-outDir window during one) never takes down the served site: you
 * keep the last good build, with a red banner and a terminal bell.
 *
 * Node built-ins only; never imported by the Worker (`src/` does not reference `bin/`). */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { cp, readdir, rm, stat } from "node:fs/promises";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildInvocation,
  canonicalPath,
  classifyWatch,
  descendantsOf,
  execLocalCommand,
  findFreePort,
  IGNORED,
  isAlive,
  lastPortFor,
  matchesName,
  PORT_TRIES,
  processTable,
  resolveWranglerBin,
} from "./lib.mjs";

const DEBOUNCE_MS = 300;
/** How long a child gets to stop after SIGTERM before SIGKILL, and then to be reaped. */
const GRACE_MS = 5000;
const REAP_MS = 2000;
const POSIX = process.platform !== "win32";
/** Never a build input, and written to by the build, wrangler, git or a framework's cache (Astro
 * writes `.astro/types.d.ts` on every build): watching them loops. Always skipped, git or not. In a
 * git work tree, gitignored paths are skipped too, except the inputs the user named: see `flush`. */
const NOISE_DIRS =
  /(^|[\\/])(node_modules|\.git|\.wrangler|\.astro|\.svelte-kit|\.next|\.nuxt|\.output|\.cache|\.turbo|\.vercel|\.parcel-cache)([\\/]|$)/;

/** node_modules/.bin of the root and every ancestor, so a custom `--build "astro build"` resolves. */
function binPath(root) {
  const dirs = [];
  for (let d = root; ; d = dirname(d)) {
    dirs.push(join(d, "node_modules", ".bin"));
    if (dirname(d) === d) break;
  }
  return [...dirs, process.env.PATH ?? ""].join(delimiter);
}

/** Sync staging → outDir in place (same directory inode, so wrangler's asset watcher sees an
 * incremental update, not a directory swap): prune entries the new build dropped, then copy over.
 * Prune runs FIRST so a path that changed type between builds (file ↔ dir) is removed before cp
 * would trip over it. */
export async function syncDirs(staging, dist) {
  await prune(staging, dist);
  await cp(staging, dist, { recursive: true, force: true });
}

async function prune(stagingDir, distDir) {
  let entries;
  try {
    entries = await readdir(distDir, { withFileTypes: true });
  } catch {
    return; // first build: the output dir doesn't exist yet — cp creates it
  }
  for (const entry of entries) {
    const s = join(stagingDir, entry.name);
    const d = join(distDir, entry.name);
    const sStat = await stat(s).catch(() => null);
    if (!sStat || sStat.isDirectory() !== entry.isDirectory()) {
      await rm(d, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      await prune(s, d);
    }
  }
}

const hasOutput = (dir) => existsSync(dir) && readdirSync(dir).length > 0;

/** Paths (relative to `root`) minus the ones git ignores — a framework cache such as `.astro/` is
 * written by every build, so under `--watch .` it would trigger the next one. A path that no
 * longer exists, or is a directory, is also asked about as `path/`, because a dir-only pattern
 * (`tmpbuild/`) doesn't match a path that no longer exists (a temp dir the build created and
 * removed); an existing regular file is not, so `lib/` never hides a file named `lib`. Outside a
 * git work tree, or if git fails or takes over 2 s, nothing is dropped. */
export function gitIgnoredFilter(root) {
  const probe = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  });
  if (probe.status !== 0 || probe.stdout.trim() !== "true") return (files) => files;
  return (files) => {
    if (files.length === 0) return files;
    // `f/` only where f could be a directory: for an existing regular file it would match a
    // dir-only pattern (`lib/`) that git itself does not apply to that file.
    const isFile = (f) => {
      try {
        return !statSync(join(root, f)).isDirectory();
      } catch {
        return false;
      }
    };
    const queries = files.flatMap((f) => (isFile(f) ? [f] : [f, `${f}/`]));
    const r = spawnSync("git", ["-C", root, "check-ignore", "--stdin", "-z"], {
      input: `${queries.join("\0")}\0`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2000,
    });
    if (r.status !== 0 && r.status !== 1) return files; // 1 = none ignored; else error or timeout
    const ignored = new Set(r.stdout.split("\0").filter(Boolean));
    return files.filter((f) => !ignored.has(f) && !ignored.has(`${f}/`));
  };
}

/** Every child the loop starts, tracked until it is gone; `stopAll` never returns before that.
 *
 * - A build runs in its own process group on POSIX (`detached`; it never reads the terminal), so
 *   one kill(-pgid) reaches everything a package manager or shell started under it — dash, Debian's
 *   sh, does not exec its last command, so signalling only the shell would orphan the real build.
 *   Its record is dropped as soon as its group is seen empty, so a pgid the OS later reuses is never
 *   signalled. A build that exits but leaves processes in its group has left strays: they get
 *   SIGTERM at once and SIGKILL after the grace period.
 * - wrangler must NOT get its own group: it reads hotkeys from the terminal, and a background
 *   process group that reads the TTY is stopped by SIGTTIN. So it is run directly with node (no
 *   package manager or shell between us), and at shutdown its descendants are snapshotted and
 *   signalled too, in case they outlive it (the package-manager fallback, or a crashed wrapper). */
export class ChildSet {
  constructor({ log = () => {}, grace = GRACE_MS, reap = REAP_MS } = {}) {
    this.recs = new Set();
    this.log = log;
    this.grace = grace;
    this.reap = reap;
  }

  get size() {
    return this.recs.size;
  }

  add(proc, { group = false } = {}) {
    const rec = { proc, group: group && POSIX, exited: !proc.pid, tree: [] };
    if (rec.exited) return rec; // never started (spawn error): nothing to track
    this.recs.add(rec);
    proc.on("exit", () => {
      rec.exited = true;
      rec.exitedAt = Date.now();
      this.settle(rec);
    });
    return rec;
  }

  /** Drop an exited child's record once nothing of it is left; deal with a build's strays. */
  settle(rec) {
    if (!rec.exited || !this.recs.has(rec)) return;
    if (!rec.group || !isAlive(-rec.proc.pid)) {
      this.recs.delete(rec);
      return;
    }
    const late = Date.now() - rec.exitedAt >= this.grace;
    if (!rec.straysTold || late) {
      if (!rec.straysTold) this.log(`build exited but left processes in its group — stopping them`);
      rec.straysTold = true;
      try {
        process.kill(-rec.proc.pid, late ? "SIGKILL" : "SIGTERM");
      } catch {}
    }
    setTimeout(() => this.settle(rec), 100).unref();
  }

  /** Re-check every exited child (before each build). */
  sweep() {
    for (const rec of this.recs) this.settle(rec);
  }

  topAlive(rec) {
    return rec.group ? isAlive(-rec.proc.pid) : !rec.exited;
  }

  alive(rec) {
    return this.topAlive(rec) || rec.tree.length > 0;
  }

  /** Forget snapshotted descendants that have died: a pid seen dead is never signalled again, so a
   * reused pid can't be hit. */
  prune(rec) {
    rec.tree = rec.tree.filter(isAlive);
  }

  signal(rec, sig, pids = []) {
    try {
      if (rec.group) process.kill(-rec.proc.pid, sig);
      else if (!rec.exited) rec.proc.kill(sig);
    } catch {}
    for (const pid of pids) {
      try {
        process.kill(pid, sig);
      } catch {}
    }
  }

  /** SIGTERM everything, SIGKILL whatever is left after the grace period, and resolve only once it
   * is all gone (or, if the OS will not reap it, after saying so). Returns pids it could not
   * confirm stopped. */
  async stopAll() {
    const table = processTable();
    const recs = [...this.recs].filter((r) => this.topAlive(r));
    for (const rec of recs) {
      if (!rec.group) rec.tree = descendantsOf(table, rec.proc.pid);
      this.signal(rec, "SIGTERM");
    }
    const deadline = Date.now() + this.grace;
    const busy = () =>
      recs.filter((r) => {
        this.prune(r);
        return this.alive(r);
      });
    while (busy().length > 0 && Date.now() < deadline) {
      for (const rec of recs) {
        // The direct child exited but left descendants behind (a wrapper that didn't forward the
        // signal): they are orphans now, so tell them directly.
        if (rec.exited && !rec.orphansTold && rec.tree.length > 0) {
          rec.orphansTold = true;
          this.signal(rec, "SIGTERM", rec.tree);
        }
      }
      await sleep(50);
    }
    const stubborn = busy();
    if (stubborn.length === 0) return [];
    this.log(`still running ${this.grace / 1000}s after SIGTERM — sending SIGKILL`);
    const now = processTable();
    for (const rec of stubborn) {
      if (!rec.group && !rec.exited) {
        rec.tree = [...new Set([...rec.tree, ...descendantsOf(now, rec.proc.pid)])];
      }
      this.signal(rec, "SIGKILL", rec.tree);
    }
    const reapBy = Date.now() + this.reap;
    while (busy().length > 0 && Date.now() < reapBy) await sleep(50);
    return busy().flatMap((r) => [
      ...(this.topAlive(r) ? [r.group ? `group ${r.proc.pid}` : r.proc.pid] : []),
      ...r.tree,
    ]);
  }
}

/** Cheap fingerprint of a directory's top level (its mtime and each entry's), to tell whether a
 * build wrote into it. null if it doesn't exist. */
function fingerprint(dir) {
  try {
    const entries = readdirSync(dir).sort();
    return [statSync(dir).mtimeMs, ...entries.map((e) => `${e}:${statSync(join(dir, e)).mtimeMs}`)];
  } catch {
    return null;
  }
}
const sameFingerprint = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Run the loop until wrangler exits or a signal arrives. Resolves to the process exit code. */
export async function dev(opts) {
  const tag = "\x1b[36m[md-router-dev]\x1b[0m";
  const log = (msg) => console.log(`${tag} ${msg}`);
  // Loud-failure banner: bold red + terminal bell (most terminals flash/bounce).
  const fail = (msg) => console.log(`${tag} \x1b[1;31m${msg}\x1b[0m\x07`);
  const warn = (msg) => console.log(`${tag} \x1b[33m${msg}\x1b[0m`);

  const stagingRel = relative(opts.root, opts.staging) || opts.staging;
  const outRel = relative(opts.root, opts.outDir) || opts.outDir;
  const inv = buildInvocation(opts);
  const buildEnv = {
    ...process.env,
    PATH: binPath(opts.root),
    MD_ROUTER_DEV_OUT_DIR: stagingRel,
    ...(opts.strict ? {} : { MD_ROUTER_DEV: "1" }),
  };

  let shuttingDown = false;
  let wrangler;
  let timer;
  const watchers = [];
  let exitResolve;
  const exited = new Promise((r) => {
    exitResolve = r;
  });
  let exitCode = 0;
  const children = new ChildSet({ log });

  function runBuild() {
    return new Promise((done) => {
      const stdio = ["ignore", "inherit", "inherit"];
      const base = { cwd: opts.root, stdio, env: buildEnv, detached: POSIX };
      const child =
        inv.shell !== undefined
          ? spawn(inv.shell, { ...base, shell: true })
          : spawn(inv.cmd, inv.args, { ...base, shell: process.platform === "win32" });
      children.add(child, { group: true });
      child.on("error", () => done(127)); // e.g. binary not found
      child.on("close", (code) => done(code ?? 1));
    });
  }

  let building = false;
  let dirty = false;
  let pendingReason = "startup";
  let buildCount = 0;

  async function rebuild() {
    if (shuttingDown) return; // a debounce callback can fire after the signal
    if (building) {
      dirty = true;
      return;
    }
    building = true;
    do {
      dirty = false;
      const n = ++buildCount;
      const t0 = Date.now();
      log(`build #${n} (${pendingReason})…`);
      // Start from an empty staging dir so a stale file from a failed build can never be synced.
      await rm(opts.staging, { recursive: true, force: true });
      if (shuttingDown) break;
      children.sweep();
      const outBefore = fingerprint(opts.outDir);
      const code = await runBuild();
      if (shuttingDown) break;
      const pointAtStaging =
        `make the build write to the staging dir: --out-dir-flag <the flag your build takes> ` +
        `(now ${opts.outDirFlag ? JSON.stringify(opts.outDirFlag) : "disabled"}), or {outDir} in --build`;
      if (
        code === 0 &&
        !hasOutput(opts.staging) &&
        !sameFingerprint(fingerprint(opts.outDir), outBefore)
      ) {
        fail(
          `build #${n} exited 0 but wrote to ${outRel}/ directly, not ${stagingRel}/ — what is ` +
            `served is whatever it left there, with no last-good-build protection. To fix, ${pointAtStaging}`
        );
      } else if (code === 0 && !hasOutput(opts.staging)) {
        fail(
          `build #${n} exited 0 but wrote nothing to ${stagingRel}/ — still serving the previous ` +
            `good build. To fix, ${pointAtStaging}`
        );
      } else if (code === 0) {
        try {
          await syncDirs(opts.staging, opts.outDir);
          log(
            `build #${n} live in ${((Date.now() - t0) / 1000).toFixed(1)}s — browser reloads itself`
          );
        } catch (err) {
          // A failed sync degrades like a failed build — never crash the loop (that would orphan
          // wrangler on the port).
          fail(
            `build #${n} sync FAILED (${err?.code ?? err}) — ${outRel}/ may be partial; next green build re-syncs`
          );
        }
      } else {
        fail(
          `build #${n} FAILED (exit ${code}) — error above; still serving the previous good build`
        );
      }
    } while (dirty && !shuttingDown);
    building = false;
  }

  // Changes are batched per debounce window. A path that git ignores (a framework cache the build
  // itself writes) is dropped before it may trigger a build, except: root-level matches of an exact
  // name, `.env*` or a name the user passed (`.env` is gitignored almost everywhere, yet a default
  // trigger), and anything under a watched directory that is itself gitignored (`--watch content`
  // where content/ is ignored) — the user asked for those explicitly.
  const pending = new Map(); // path → may be git-filtered
  const notIgnored = gitIgnoredFilter(opts.root);
  function onChange(file, filterable) {
    pending.set(file, (pending.get(file) ?? true) && filterable);
    clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  }
  function flush() {
    if (shuttingDown) return;
    const always = [...pending].filter(([, f]) => !f).map(([p]) => p);
    const files = [...always, ...notIgnored([...pending].filter(([, f]) => f).map(([p]) => p))];
    pending.clear();
    if (files.length === 0) return;
    pendingReason = files.length > 1 ? `${files[0]} +${files.length - 1} more` : files[0];
    void rebuild();
  }

  function startWatchers() {
    const { dirs: rawDirs, names, dropped } = classifyWatch(opts.root, opts.watch);
    for (const { entry, why } of dropped) {
      if (opts.userWatch?.includes(entry)) warn(`not watching --watch ${entry}: ${why}`);
    }
    // Canonical, and without dirs already covered by another (`--watch .` contains src/).
    const canon = [...new Set(rawDirs.map((d) => canonicalPath(d)))];
    const dirs = canon.filter(
      (d) => !canon.some((o) => o !== d && d.startsWith(o === sep ? o : o + sep))
    );
    // The build's own output (and staging) is never an input: a watch that covers it — `--watch .`
    // — would otherwise rebuild forever. Both are canonical (resolveOptions), as are `dirs`, so the
    // prefix check matches the spelling the filesystem reports.
    const ignoredRoots = [opts.outDir, opts.staging];
    const under = (abs, roots) => roots.some((r) => abs === r || abs.startsWith(r + sep));
    // Watched dirs (nested ones included) that git itself ignores: their events are never filtered.
    const exempt = canon.filter(
      (d) => d !== opts.root && notIgnored([relative(opts.root, d)]).length === 0
    );
    for (const dir of dirs) {
      if (under(dir, ignoredRoots)) continue;
      watchers.push(
        watch(dir, { recursive: true }, (_event, file) => {
          if (!file || IGNORED.test(file) || NOISE_DIRS.test(file)) return;
          const abs = join(dir, file);
          if (under(abs, ignoredRoots)) return;
          onChange(relative(opts.root, abs), !under(abs, exempt));
        })
      );
    }
    // Root-level names that skip the git filter: exact names, `.env*` (gitignored almost everywhere,
    // yet an input), and anything the user passed. A prefix-glob default like `vite.config.*` still
    // goes through it, since tools drop gitignored temp files next to their config.
    const explicitName = (n) => !n.endsWith("*") || n === ".env*" || opts.userWatch?.includes(n);
    // Root-level files: a non-recursive watch on the directory survives editors that replace files
    // on save (watching a file itself would not).
    if (names.length > 0) {
      watchers.push(
        watch(opts.root, (_event, file) => {
          if (file && !IGNORED.test(file) && matchesName(names, file)) {
            onChange(file, !names.some((n) => matchesName([n], file) && explicitName(n)));
          }
        })
      );
    }
    return { dirs, names };
  }

  /** Idempotent: the first caller's exit code wins (a user's Ctrl-C stays 0 even though wrangler
   * then dies of the signal). Resolves `exited` only once every child is gone. */
  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    exitCode = code;
    clearTimeout(timer);
    for (const w of watchers) w.close(); // open watchers would keep the event loop alive
    children
      .stopAll()
      .then((left) => {
        if (left.length > 0)
          fail(`could not confirm these stopped: ${left.join(", ")} — check with ps`);
      })
      .catch((err) => fail(`stopping children failed: ${err?.stack ?? err}`))
      .finally(() => exitResolve(exitCode));
  }

  const onSignal = () => shutdown(0);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal); // closed terminal / dropped ssh
  // Backstop for anything the loop doesn't catch (incl. fs.watch 'error' events): tear wrangler
  // down with us rather than orphaning it on the port.
  const onFatal = (event) => (err) => {
    fail(`fatal (${event}): ${err?.stack ?? err}`);
    shutdown(1);
  };
  const fatalHandlers = ["uncaughtException", "unhandledRejection"].map((e) => [e, onFatal(e)]);
  for (const [e, h] of fatalHandlers) process.on(e, h);
  const cleanup = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    for (const [e, h] of fatalHandlers) process.off(e, h);
  };

  const run = async () => {
    log(
      `build: ${inv.shell ?? `${inv.cmd} ${inv.args.join(" ")}`}  →  ${stagingRel}/  →  ${outRel}/`
    );
    if (hasOutput(opts.outDir)) {
      log(`serving the existing ${outRel}/ while a fresh build runs`);
      void rebuild();
    } else {
      log(`no ${outRel}/ yet — first build must finish before serving starts`);
      await rebuild();
      if (!hasOutput(opts.outDir) && !shuttingDown) {
        fail("first build failed and there is no previous output to serve — exiting");
        return 1;
      }
    }
    if (shuttingDown) return exitCode;

    // Resolved here rather than at startup so the gap between "it was free" and "wrangler has it"
    // stays small — a cold-start build is minutes of window for someone else to take the port.
    const port = await findFreePort(opts.port, PORT_TRIES);
    if (port === null) {
      fail(
        `no free port in ${opts.port}–${lastPortFor(opts.port, PORT_TRIES)}. ` +
          `Stop one of the servers holding them, or pass --port / set PORT to a clear range.`
      );
      return 1;
    }
    if (shuttingDown) return exitCode;
    if (port !== opts.port) {
      log(`port ${opts.port} is busy (often a dev server from another checkout) — using ${port}`);
    }

    // wrangler treats an explicit --port as strict (dies rather than moving), which is why the
    // walk-up above is ours.
    const wranglerArgs = [
      "dev",
      "--live-reload",
      "--port",
      String(port),
      ...(opts.wranglerConfig ? ["--config", opts.wranglerConfig] : []),
      ...opts.wranglerArgs,
    ];
    // The site's own wrangler, run by node itself: nothing in between to swallow our signals.
    const wranglerJs = resolveWranglerBin(opts.root);
    let cmd = process.execPath;
    let args = [wranglerJs, ...wranglerArgs];
    if (!wranglerJs) {
      // Not resolvable from the site (not installed, or Yarn PnP): let the package manager find
      // its local one — still never downloads. Its signal handling is the package manager's.
      [cmd, args] = execLocalCommand(opts.pm, "wrangler", wranglerArgs);
      log(
        `no wrangler package resolvable from ${opts.root} — running \`${cmd} ${args.slice(0, 2).join(" ")}…\` ` +
          `instead. If wrangler is not installed: ${opts.pm} add -D wrangler`
      );
    }
    if (shuttingDown) return exitCode;
    wrangler = spawn(cmd, args, {
      cwd: opts.root,
      stdio: "inherit",
      shell: !wranglerJs && process.platform === "win32",
    });
    children.add(wrangler);
    wrangler.on("error", (err) => {
      fail(
        `could not start wrangler via ${cmd}: ${err.message} — install it in the site: ${opts.pm} add -D wrangler`
      );
      shutdown(1);
    });
    // wrangler owns the terminal UX; when it exits (its `x` hotkey, a crash), take the loop down.
    // Death by signal is a failure, not a clean exit.
    wrangler.on("exit", (code, sig) => shutdown(code ?? (sig ? 1 : 0)));

    const { dirs, names } = startWatchers();
    const shown = [...dirs.map((d) => `${relative(opts.root, d) || "."}/`), ...names];
    log(`watching ${shown.join(", ") || "nothing"} — wrangler serves http://localhost:${port}`);
    log(
      opts.strict
        ? "strict mode: MD_ROUTER_DEV is NOT set for builds"
        : "MD_ROUTER_DEV=1 is set for builds (use --strict to unset it)"
    );
    return undefined;
  };

  try {
    let early;
    try {
      early = await run();
    } catch (err) {
      // e.g. fs.watch throwing ENOSPC (inotify limit) after wrangler started: never leave it running.
      fail(`fatal: ${err?.message ?? err} — stopping`);
      early = 1;
    }
    if (early !== undefined) shutdown(early);
    return await exited;
  } finally {
    cleanup();
  }
}
