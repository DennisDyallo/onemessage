import fs from "node:fs";
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

export type AttachmentPathResult =
  | { success: true; path: string }
  | { success: false; reason: "path-traversal-rejected" | "file-missing" | "file-ambiguous" };

/**
 * Construct a safe path for a signal-cli attachment with detailed failure reasons.
 *
 * signal-cli stores files as `<id>.<ext>` (e.g., "abc123.aac", "xyz789.jpg").
 * This function:
 *   1. Validates the ID is safe (charset check)
 *   2. Globs the directory for files matching `<id>.*`
 *   3. Returns success with path if exactly ONE match found
 *   4. Returns failure with reason code otherwise
 *
 * @param baseDir - The signal-cli attachments directory
 * @param id - The attachment ID (bare, without extension)
 * @returns Result object with path or failure reason
 */
export function constructSafeSignalAttachmentPathWithReason(
  baseDir: string,
  id: string | undefined,
): AttachmentPathResult {
  // Charset validation first (no filesystem access if malicious)
  if (!isValidSignalAttachmentId(id)) {
    return { success: false, reason: "path-traversal-rejected" };
  }

  // Type guard: id is now guaranteed to be a non-empty string
  const safeId = id as string;

  // Read directory and find files matching <id>.*
  let entries: string[];
  try {
    entries = fs.readdirSync(baseDir);
  } catch {
    // Directory doesn't exist or not readable
    return { success: false, reason: "file-missing" };
  }

  // Filter for files that start with "<id>." (anchored match)
  const pattern = `${safeId}.`;
  const matches = entries.filter((entry) => entry.startsWith(pattern));

  // Require exactly one match
  if (matches.length === 0) {
    return { success: false, reason: "file-missing" };
  }

  if (matches.length > 1) {
    return { success: false, reason: "file-ambiguous" };
  }

  // Single match: construct and validate the resolved path
  const matchedFile = matches[0];
  if (!matchedFile) {
    // Should never happen given length check above, but TypeScript doesn't know that
    return { success: false, reason: "file-missing" };
  }

  const candidate = path.join(baseDir, matchedFile);
  const resolved = path.resolve(candidate);
  const resolvedBase = path.resolve(baseDir);

  // Ensure the resolved path is within the base directory
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    return { success: false, reason: "path-traversal-rejected" };
  }

  return { success: true, path: resolved };
}

/**
 * Construct a safe path for a signal-cli attachment.
 *
 * signal-cli stores files as `<id>.<ext>` (e.g., "abc123.aac", "xyz789.jpg").
 * This function:
 *   1. Validates the ID is safe (charset check)
 *   2. Globs the directory for files matching `<id>.*`
 *   3. Returns the path if exactly ONE match found
 *   4. Returns null if 0 matches (file-missing) or 2+ matches (file-ambiguous)
 *
 * @param baseDir - The signal-cli attachments directory
 * @param id - The attachment ID (bare, without extension)
 * @returns Absolute path to the attachment file, or null if not found/ambiguous/unsafe
 */
export function constructSafeSignalAttachmentPath(
  baseDir: string,
  id: string | undefined,
): string | null {
  const result = constructSafeSignalAttachmentPathWithReason(baseDir, id);
  return result.success ? result.path : null;
}
