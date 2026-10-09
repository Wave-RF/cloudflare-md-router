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

import { spawn } from "node:child_process";
import { existsSync, readdirSync, watch } from "node:fs";
import { cp, readdir, rm, stat } from "node:fs/promises";
import { delimiter, dirname, join, relative } from "node:path";
import {
  buildInvocation,
  classifyWatch,
  execLocalCommand,
  findFreePort,
  IGNORED,
  lastPortFor,
  matchesName,
  PORT_TRIES,
} from "./lib.mjs";

const DEBOUNCE_MS = 300;
const POSIX = process.platform !== "win32";

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

/** Run the loop until wrangler exits or a signal arrives. Resolves to the process exit code. */
export async function dev(opts) {
  const tag = "\x1b[36m[md-router-dev]\x1b[0m";
  const log = (msg) => console.log(`${tag} ${msg}`);
  // Loud-failure banner: bold red + terminal bell (most terminals flash/bounce).
  const fail = (msg) => console.log(`${tag} \x1b[1;31m${msg}\x1b[0m\x07`);

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
  let activeBuild = null;
  let wrangler;
  let timer;
  const watchers = [];
  let exitResolve;
  const exited = new Promise((r) => {
    exitResolve = r;
  });
  let exitCode = 0;

  const killChild = (child, signal) => {
    if (!child || child.exitCode !== null) return;
    try {
      // Builds run detached (own process group) so the shell's grandchildren die with them.
      if (POSIX && child === activeBuild) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {}
  };

  function runBuild() {
    return new Promise((done) => {
      const stdio = ["ignore", "inherit", "inherit"];
      const base = { cwd: opts.root, stdio, env: buildEnv, detached: POSIX };
      const child =
        inv.shell !== undefined
          ? spawn(inv.shell, { ...base, shell: true })
          : spawn(inv.cmd, inv.args, { ...base, shell: process.platform === "win32" });
      activeBuild = child;
      const finish = (code) => {
        if (activeBuild === child) activeBuild = null;
        done(code);
      };
      child.on("error", () => finish(127)); // e.g. binary not found
      child.on("close", (code) => finish(code ?? 1));
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
      const code = await runBuild();
      if (shuttingDown) break;
      if (code === 0 && !hasOutput(opts.staging)) {
        fail(
          `build #${n} exited 0 but wrote nothing to ${stagingRel}/ — does your build honour ` +
            `--out-dir-flag (${opts.outDirFlag || "disabled"}) or {outDir}? Still serving the previous good build`
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

  function onChange(file) {
    pendingReason = file;
    clearTimeout(timer);
    timer = setTimeout(rebuild, DEBOUNCE_MS);
  }

  function startWatchers() {
    const { dirs, names } = classifyWatch(opts.root, opts.watch);
    const ignoredRoots = [opts.outDir, opts.staging];
    for (const dir of dirs) {
      if (ignoredRoots.some((r) => dir === r || dir.startsWith(r + "/"))) continue;
      watchers.push(
        watch(dir, { recursive: true }, (_event, file) => {
          if (!file || IGNORED.test(file)) return;
          onChange(relative(opts.root, join(dir, file)));
        })
      );
    }
    // Root-level files: a non-recursive watch on the directory survives editors that replace files
    // on save (watching a file itself would not).
    if (names.length > 0) {
      watchers.push(
        watch(opts.root, (_event, file) => {
          if (file && !IGNORED.test(file) && matchesName(names, file)) onChange(file);
        })
      );
    }
    return { dirs, names };
  }

  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    exitCode = code;
    clearTimeout(timer);
    for (const w of watchers) w.close(); // open watchers would keep the event loop alive
    killChild(activeBuild, "SIGINT");
    killChild(wrangler, "SIGINT");
    // A stubborn child must not hold the port forever.
    const hard = setTimeout(() => {
      killChild(activeBuild, "SIGKILL");
      killChild(wrangler, "SIGKILL");
      exitResolve(exitCode);
    }, 5000);
    hard.unref();
    if (!wrangler && !activeBuild) exitResolve(exitCode);
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
    // walk-up above is ours. Run via the site's package manager so it's the locally-installed one.
    const [cmd, args] = execLocalCommand(opts.pm, "wrangler", [
      "dev",
      "--live-reload",
      "--port",
      String(port),
      ...(opts.wranglerConfig ? ["--config", opts.wranglerConfig] : []),
      ...opts.wranglerArgs,
    ]);
    wrangler = spawn(cmd, args, {
      cwd: opts.root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    wrangler.on("error", (err) => {
      fail(`could not start wrangler via ${cmd}: ${err.message}`);
      shutdown(1);
    });
    // wrangler owns the terminal UX; when it exits (its `x` hotkey, a crash), take the loop down.
    wrangler.on("close", (code) => {
      shutdown(code ?? 0);
      exitResolve(exitCode);
    });

    const { dirs, names } = startWatchers();
    const shown = [...dirs.map((d) => `${relative(opts.root, d)}/`), ...names];
    log(`watching ${shown.join(", ") || "nothing"} — wrangler serves http://localhost:${port}`);
    log(
      opts.strict
        ? "strict mode: MD_ROUTER_DEV is NOT set for builds"
        : "MD_ROUTER_DEV=1 is set for builds (use --strict to unset it)"
    );
    return undefined;
  };

  try {
    const early = await run();
    if (early !== undefined) {
      shutdown(early);
      // Nothing left running if we never started wrangler.
      if (!wrangler) exitResolve(early);
    }
    return await exited;
  } finally {
    cleanup();
  }
}
