import { realpathSync, lstatSync, readlinkSync } from 'fs'
import { dirname, isAbsolute, join } from 'path'

/**
 * Resolve `file` to the path that an atomic-write `rename(2)` should land on,
 * so a symlink (or a chain of symlinks) at `file` is preserved across the
 * write rather than getting silently replaced by a regular file.
 *
 * Four scenarios cover every realistic dotfiles deployment shape:
 *
 *   1. Plain real file or path that does not exist at all
 *      → return `file` unchanged. `realpathSync` succeeds for the real-file
 *        case; the absent-path case falls through to the literal fallback.
 *
 *   2. Symlink (single or chained) whose final target already exists
 *      → return the resolved real path. `realpathSync` walks the whole
 *        chain in one call and lands on the real file.
 *
 *   3. Dangling symlink — link in place, final target does not exist yet
 *      (typical dotfiles flow: `make apply-tool` creates the link before
 *      the daemon's first write produces the target).
 *      → `realpathSync` throws ENOENT, so we walk the chain ourselves
 *        with bounded `lstat` + `readlink` steps. Stop at the first path
 *        that is either non-existent or a non-symlink — that path is what
 *        the atomic rename should materialize. Naive single-step readlink
 *        would stop on the *next* link in the chain instead of the final
 *        target, and rename(2) would then unlink that intermediate symlink.
 *
 *   4. Symlink cycle — `a -> b -> a` or pathologically deep chain
 *      → the bounded walk hits the depth cap (MAX_SYMLINK_DEPTH, matching
 *        Linux's MAXSYMLINKS = 40) and bails out by returning `file`. The
 *        chain is already broken in this case so any choice is lossy; we
 *        pick "fall back to the literal path" over "spin forever" or
 *        "throw" so caller code stays simple.
 *
 * Cases 3 and 4 were both caught in code review of earlier patches:
 *   d91d887 missed case 3; b19eb0f handled only one chain step (so a
 *   two-link chain still clobbered the middle link); this pass handles
 *   arbitrary chain depth with a cycle guard. Regression tests in
 *   symlink-target.test.ts pin each case.
 */
const MAX_SYMLINK_DEPTH = 40

export function resolveAtomicTarget(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    // realpathSync failed somewhere along the chain. Walk it manually:
    // each step asks "is this path a symlink that still resolves?", and
    // we stop on the first step that is either ENOENT (the rename target)
    // or a real non-symlink path.
    let current = file
    for (let step = 0; step < MAX_SYMLINK_DEPTH; step++) {
      let st
      try {
        st = lstatSync(current)
      } catch {
        // Reached a non-existent path. That is what rename(2) should
        // materialize so every symlink upstream stays intact.
        return current
      }
      if (!st.isSymbolicLink()) {
        // Reached a real file or directory. Atomic-write semantics will
        // legitimately overwrite it; symlinks upstream still survive.
        return current
      }
      const link = readlinkSync(current)
      // POSIX: relative readlink values are interpreted relative to the
      // directory containing the symlink, not the process cwd.
      current = isAbsolute(link) ? link : join(dirname(current), link)
    }
    // Hit the depth cap — either a true cycle (a -> b -> a) or a chain
    // deeper than MAXSYMLINKS. Either way the user's link graph is
    // already broken; refuse to "guess" a target and let rename(2)
    // operate on the literal path. Worst case the entry-point symlink
    // gets clobbered, which is no worse than the pre-patch behavior.
    return file
  }
}
