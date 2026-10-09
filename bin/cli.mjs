#!/usr/bin/env node
/* `cloudflare-md-router <command>` — currently one command: `dev`. */
import { dev } from "./dev.mjs";
import { HELP, parseArgs, resolveOptions } from "./lib.mjs";

const [command, ...rest] = process.argv.slice(2);

if (command !== "dev") {
  console.log(
    command && command !== "--help" && command !== "-h" ? `unknown command ${command}\n` : ""
  );
  console.log(HELP);
  process.exit(command === undefined || command === "--help" || command === "-h" ? 0 : 1);
}

let opts;
try {
  const flags = parseArgs(rest);
  if (flags.help) {
    console.log(HELP);
    process.exit(0);
  }
  opts = resolveOptions(flags, process.env, process.cwd());
} catch (err) {
  console.error(`\x1b[1;31mcloudflare-md-router dev: ${err.message}\x1b[0m\x07`);
  process.exit(1);
}

process.exitCode = await dev(opts);
