import type { Attachment } from "../types";

/**
 * Validate attachment data/path invariants.
 *
 * When attachmentsRequested is true:
 *   - Exactly one of `data` or `path` must be set (XOR invariant)
 *
 * When attachmentsRequested is false (inbox-light mode):
 *   - Neither `data` nor `path` should be set
 *
 * @throws {Error} When invariants are violated
 */
export function validateAttachment(att: Attachment, opts: { attachmentsRequested: boolean }): void {
  const hasData = att.data !== undefined;
  const hasPath = att.path !== undefined;

  if (opts.attachmentsRequested) {
    // When attachments were requested, exactly one of data/path must be set
    if (hasData && hasPath) {
      throw new Error(
        `Attachment "${att.filename}": both data and path are set (expected exactly one)`,
      );
    }
    if (!hasData && !hasPath) {
      throw new Error(
        `Attachment "${att.filename}": neither data nor path is set (expected exactly one when attachments requested)`,
      );
    }
  } else {
    // Inbox-light mode: neither should be set
    if (hasData || hasPath) {
      throw new Error(
        `Attachment "${att.filename}": data or path should not be set when attachments were not requested (inbox-light mode)`,
      );
    }
  }
}
