import { resolve, sep } from "node:path";

/**
 * Validate that a string is safe for use as a filesystem path component.
 *
 * This prevents path traversal attacks (e.g., "../../../etc/passwd") by:
 * - Rejecting empty/undefined strings
 * - Enforcing a max length (256 chars)
 * - Restricting charset to alphanumeric + hyphens/underscores + optional base64 padding
 * - Disallowing dots (prevents .. traversal), slashes, null bytes, etc.
 *
 * @param id - The identifier to validate (message ID, attachment ID, etc.)
 * @param opts - Optional configuration
 * @param opts.allowBase64Padding - Allow trailing = or == (for base64-encoded IDs)
 * @returns true if the ID is safe for filesystem use, false otherwise
 */
export function isSafeFilesystemId(
  id: string | undefined,
  opts?: { allowBase64Padding?: boolean },
): boolean {
  if (!id) return false;
  if (typeof id !== "string") return false;
  if (id.length === 0) return false;
  if (id.length > 256) return false; // Reasonable upper bound

  // Base pattern: letters, numbers, hyphens, underscores only
  // Optionally allow trailing = for base64 padding
  const pattern = opts?.allowBase64Padding
    ? /^[A-Za-z0-9_-]+=*$/ // Allow trailing = or ==
    : /^[A-Za-z0-9_-]+$/; // No padding

  if (!pattern.test(id)) return false;

  return true;
}

/**
 * Verify that a candidate path is contained within a base directory.
 *
 * This prevents path traversal attacks by resolving both paths to absolute form
 * and checking that the candidate is within the base directory tree.
 *
 * Example:
 *   ensureWithinDir("/tmp/base/file.txt", "/tmp/base") → true
 *   ensureWithinDir("/tmp/base/../etc/passwd", "/tmp/base") → false
 *
 * @param candidatePath - The path to validate (may be relative or absolute)
 * @param baseDir - The base directory that should contain the candidate
 * @returns true if candidatePath is within baseDir after resolution, false otherwise
 */
export function ensureWithinDir(candidatePath: string, baseDir: string): boolean {
  const resolved = resolve(candidatePath);
  const resolvedBase = resolve(baseDir);

  // Candidate must either:
  // 1. Start with resolvedBase + path.sep (child path)
  // 2. Equal resolvedBase exactly (same directory)
  return resolved.startsWith(resolvedBase + sep) || resolved === resolvedBase;
}
