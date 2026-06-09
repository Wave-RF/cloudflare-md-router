// Prints the content-addressed dev version used by the `@dev` dist-tag publish
// in .github/workflows/publish-npm.yml:
//
//   0.0.0-dev.h<sha256(shipped src/ tree + package.json sans version)[:12]>
//
// `0.0.0-dev.*` always sorts below any real `0.x` release and lives on its own
// dist-tag, so a `^0.2.0` consumer can never resolve to it. The hash is over the
// shipped CODE — the entire `src/` tree (this package ships raw TypeScript; the
// `files` allowlist is `src`, `README.md`, `LICENSE`, and only `src/` changes
// behavior) — plus package.json with `version` removed, so an unchanged build
// maps to an already-published version and the workflow skips it.
//
// `src/` is walked recursively and the file list is SORTED so the hash is
// deterministic regardless of readdir order; each file contributes its relative
// path (with `\0`) then its bytes, so adding/removing/renaming a file changes
// the hash. No `HASHED_FILES` list to maintain — new files under `src/` are
// picked up automatically.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Relative paths of every file under `dir`, sorted for a stable hash. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out.sort();
}

const h = createHash("sha256");
for (const f of walk("src")) {
  // Normalize path separators so the hash is identical on Windows and POSIX.
  h.update(`${f.split("\\").join("/")}\0`);
  h.update(readFileSync(f));
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
delete pkg.version;
h.update("package.json\0");
h.update(JSON.stringify(pkg));

process.stdout.write(`0.0.0-dev.h${h.digest("hex").slice(0, 12)}`);
