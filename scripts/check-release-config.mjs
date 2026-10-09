#!/usr/bin/env node
// Exercises the two semantic-release plugins that read the conventional-commits
// preset — the commit analyzer and the release-notes generator — with the exact
// plugin options in .releaserc.json, against synthetic commits. Offline: no git,
// no network, no npm or GitHub writes.
//
// Why this exists: the preset and the notes generator are coupled through
// conventional-changelog-writer, and an incompatible pair only fails at
// generateNotes, AFTER the analyzer has passed — i.e. on main, mid-release.
// Running both steps here turns a bad bump into a red PR instead. (Preset 10.x
// with release-notes-generator 14.x is exactly that pair: "requires
// conventional-changelog-writer@9".)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import { generateNotes } from "@semantic-release/release-notes-generator";

const config = JSON.parse(readFileSync(new URL("../.releaserc.json", import.meta.url), "utf8"));
const optionsFor = (name) => {
  const entry = config.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name);
  assert.ok(entry, `${name} is missing from .releaserc.json`);
  return Array.isArray(entry) ? entry[1] : {};
};
const analyzer = optionsFor("@semantic-release/commit-analyzer");
const notes = optionsFor("@semantic-release/release-notes-generator");

const quiet = { log() {}, warn() {}, error() {}, success() {} };
const commit = (message, i) => ({
  message,
  hash: `${i}`.padStart(40, "0"),
  commit: { short: `${i}`.padStart(7, "0") },
  committerDate: "2026-01-01T00:00:00Z",
});
const context = (messages) => ({
  cwd: process.cwd(),
  env: {},
  logger: quiet,
  commits: messages.map(commit),
  options: { repositoryUrl: "https://github.com/example/example.git" },
  lastRelease: { gitTag: "v1.2.3", version: "1.2.3" },
  nextRelease: { gitTag: "v1.3.0", version: "1.3.0" },
});

const cases = [
  [["ci: bump an action", "deps: bump a dev dependency", "docs: fix a typo"], null],
  [["chore: tidy", "refactor: rename", "test: add a case", "build: tweak", "style: format"], null],
  [["fix: handle a trailing slash"], "patch"],
  [["fix(deps): bump a runtime dependency"], "patch"],
  [["perf: skip a lookup"], "patch"],
  [["feat: add an option"], "minor"],
  [["feat!: drop the default export"], "major"],
  [["ci!: require Node 24"], "major"],
  [["refactor: rewrite routing\n\nBREAKING CHANGE: the Link header is opt-in"], "major"],
];
for (const [messages, expected] of cases) {
  const got = await analyzeCommits(analyzer, context(messages));
  assert.equal(got, expected, `${JSON.stringify(messages)} → expected ${expected}, got ${got}`);
}

const body = await generateNotes(
  notes,
  context(["feat: add an option", "fix: handle a trailing slash"])
);
assert.match(body, /### Features/, "release notes lack a Features section");
assert.match(body, /add an option/, "release notes lack the feat entry");
assert.match(body, /### Bug Fixes/, "release notes lack a Bug Fixes section");

console.log(`release config ok: ${cases.length} analyzer cases, release notes rendered`);
