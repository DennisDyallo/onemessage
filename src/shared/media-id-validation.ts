/**
 * Validate that a message ID is safe for filesystem path construction.
 *
 * Message IDs from providers (WhatsApp, Signal, etc.) are typically alphanumeric,
 * but we should never trust upstream input. This prevents path traversal attacks
 * (e.g., "../../../etc/passwd", "/tmp/malicious").
 *
 * @param id - The message ID from a provider
 * @returns true if the ID is safe for use in filesystem paths, false otherwise
 */
export function isValidMediaId(id: string | undefined): boolean {
  if (!id) return false;
  if (typeof id !== "string") return false;
  if (id.length === 0) return false;
  if (id.length > 256) return false; // Reasonable upper bound

  // Allow: letters, numbers, hyphens, underscores only
  // Disallow: path separators (/ \), dots (. to prevent .. traversal),
  //           null bytes, whitespace, and all other special characters
  const safePattern = /^[A-Za-z0-9_-]+$/;
  if (!safePattern.test(id)) return false;

  return true;
}
