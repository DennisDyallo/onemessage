import path from "node:path";

/**
 * Validate that a signal-cli attachment ID is safe for filesystem path construction.
 *
 * Signal-cli attachment IDs are expected to be alphanumeric with hyphens/underscores.
 * This prevents path traversal attacks (e.g., "../../../etc/passwd").
 *
 * @param id - The attachment ID from signal-cli JSON
 * @returns true if the ID is safe, false otherwise
 */
export function isValidSignalAttachmentId(id: string | undefined): boolean {
  if (!id) return false;
  if (typeof id !== "string") return false;
  if (id.length === 0) return false;
  if (id.length > 256) return false; // Reasonable upper bound

  // Signal-cli IDs are typically base64-like or UUID-like
  // Allow: letters, numbers, hyphens, underscores, equals (for base64 padding)
  // Disallow: path separators, null bytes, dots (to prevent .. traversal)
  const safePattern = /^[A-Za-z0-9_-]+=*$/;
  if (!safePattern.test(id)) return false;

  return true;
}

/**
 * Construct a safe path for a signal-cli attachment.
 *
 * Returns null if the ID is invalid or if the resolved path escapes the base directory.
 *
 * @param baseDir - The signal-cli attachments directory
 * @param id - The attachment ID
 * @returns Absolute path within baseDir, or null if unsafe
 */
export function constructSafeSignalAttachmentPath(
  baseDir: string,
  id: string | undefined,
): string | null {
  if (!isValidSignalAttachmentId(id)) {
    return null;
  }

  // Type guard: id is now guaranteed to be a non-empty string
  const candidate = path.join(baseDir, id as string);
  const resolved = path.resolve(candidate);
  const resolvedBase = path.resolve(baseDir);

  // Ensure the resolved path is within the base directory
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    return null;
  }

  return resolved;
}
