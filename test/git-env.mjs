/* Git exports GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, ... to hooks. A test that spawns `git` with
 * that environment acts on the repository running the hook, not on its own temp dir: in a linked
 * worktree `git init <tmp>` with GIT_DIR set re-initializes the MAIN repository as bare. Every git
 * spawn in test/ passes this env instead of inheriting process.env. */
export function cleanGitEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => !k.toUpperCase().startsWith("GIT_"))
  );
}

/* For the bin/ helpers that run git themselves (gitTrackedFiles, gitIgnoredFilter) in-process: they
 * inherit process.env, so run them with the GIT_* variables removed, then put them back. */
export function withCleanGitEnv(fn) {
  const saved = Object.entries(process.env).filter(([k]) => k.toUpperCase().startsWith("GIT_"));
  for (const [k] of saved) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) process.env[k] = v;
  }
}
