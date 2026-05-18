import type { Attachment } from "../types";

/**
 * Validate attachment data/path/unavailable invariants.
 *
 * When attachmentsRequested is true:
 *   - Exactly one of `data`, `path`, or `unavailable` must be set
 *   - `data`: base64-encoded bytes (email)
 *   - `path`: absolute filesystem path (signal/whatsapp)
 *   - `unavailable`: reason code when bytes cannot be fetched
 *
 * Known `unavailable` reason codes:
 *   - "no-id": signal-cli attachment has no ID field
 *   - "file-missing": signal-cli attachment file doesn't exist on disk
 *   - "path-traversal-rejected": signal-cli attachment path contains ".."
 *   - "invalid-msg-id": message ID contains path traversal attempts or invalid characters
 *   - "size-exceeded": attachment exceeds size cap (10 MB for WhatsApp audio)
 *   - "download-empty": download returned 0 bytes (network blip, expired URL, decryption failure)
 *   - "download-failed": download attempt threw an error (network/auth/etc)
 *   - "history-sync-skipped": WhatsApp history sync - downloads disabled to prevent flood
 *
 * When attachmentsRequested is false (inbox-light mode):
 *   - None of `data`, `path`, or `unavailable` should be set
 *
 * @throws {Error} When invariants are violated
 */
export function validateAttachment(att: Attachment, opts: { attachmentsRequested: boolean }): void {
  const hasData = att.data !== undefined;
  const hasPath = att.path !== undefined;
  const hasUnavailable = att.unavailable !== undefined;
  const count = [hasData, hasPath, hasUnavailable].filter(Boolean).length;

  if (opts.attachmentsRequested) {
    // When attachments were requested, exactly one of data/path/unavailable must be set
    if (count === 0) {
      throw new Error(
        `Attachment "${att.filename}": none of data, path, or unavailable is set (expected exactly one when attachments requested)`,
      );
    }
    if (count > 1) {
      const fields = [hasData && "data", hasPath && "path", hasUnavailable && "unavailable"].filter(
        Boolean,
      );
      throw new Error(
        `Attachment "${att.filename}": multiple fields set [${fields.join(", ")}] (expected exactly one)`,
      );
    }
  } else {
    // Inbox-light mode: none should be set
    if (count > 0) {
      throw new Error(
        `Attachment "${att.filename}": data, path, or unavailable should not be set when attachments were not requested (inbox-light mode)`,
      );
    }
  }
}
