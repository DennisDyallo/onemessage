import { isSafeFilesystemId } from "./path-safety.ts";

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
  // Delegate to shared validator (no base64 padding for media IDs)
  return isSafeFilesystemId(id);
}
