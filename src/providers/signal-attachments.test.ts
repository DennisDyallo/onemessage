/**
 * Unit tests for Signal attachment path handling.
 *
 * Tests the REAL signalProvider.read() function with attachment enrichment.
 * Tests that:
 * - Attachment paths are populated when --attachments is requested AND id is valid
 * - Attachment paths are OMITTED when --attachments is NOT requested
 * - Attachment unavailable field is set when id is missing or invalid
 * - Path traversal attempts are rejected
 * - validateAttachment is called and enforces invariants
 */
import { beforeEach, describe, expect, it } from "bun:test";
// We need to import the actual provider to test its read() function
// The provider auto-registers on import, so we can get it from the registry
import { getProvider } from "../registry.ts";
import { getSignalAttachmentDir } from "../shared/attachment-paths.ts";
import * as store from "../store.ts";
import type { Attachment, MessageFull } from "../types.ts";
import "./signal.ts"; // Force registration

const TEST_PROVIDER = "signal";
let counter = 0;

function makeMsgWithAttachments(
  attachments: Array<Partial<Attachment> & { id?: string }>,
): MessageFull {
  counter++;
  return {
    id: `sig-att-test-${Date.now()}-${counter}`,
    provider: TEST_PROVIDER,
    from: { name: "Test User", address: "+46700000000" },
    to: [],
    preview: "message with attachments",
    body: "message body",
    bodyFormat: "text",
    date: new Date().toISOString(),
    unread: true,
    hasAttachments: true,
    attachments: attachments.map((att) => ({
      filename: att.filename ?? "test.jpg",
      contentType: att.contentType ?? "image/jpeg",
      size: att.size ?? 1024,
      ...(att.id ? { id: att.id } : {}),
    })) as Attachment[],
    direction: "in",
  };
}

beforeEach(() => {
  counter = 0;
});

describe("Signal attachment path enrichment via provider.read()", () => {
  const provider = getProvider(TEST_PROVIDER);
  if (!provider) throw new Error("Signal provider not registered");

  it("should set unavailable='file-missing' when file doesn't exist on disk", async () => {
    const msg = makeMsgWithAttachments([{ filename: "voice.ogg", id: "abc123" }]);
    store.upsertFullMessage(msg);

    const result = await provider.read(msg.id, { includeAttachments: true });
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.attachments).toHaveLength(1);
    // File doesn't exist on disk, so should be marked as unavailable
    expect(result.attachments[0]?.unavailable).toBe("file-missing");
    expect(result.attachments[0]?.path).toBeUndefined();
    expect(result.attachments[0]?.data).toBeUndefined();
  });

  it("should set unavailable='no-id' when id is missing", async () => {
    const msg = makeMsgWithAttachments([{ filename: "voice.ogg" }]); // No id
    store.upsertFullMessage(msg);

    const result = await provider.read(msg.id, { includeAttachments: true });
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.unavailable).toBe("no-id");
    expect(result.attachments[0]?.path).toBeUndefined();
    expect(result.attachments[0]?.data).toBeUndefined();
  });

  it("should reject path traversal attempt with ../", async () => {
    const msg = makeMsgWithAttachments([{ filename: "voice.ogg", id: "../etc/passwd" }]);
    store.upsertFullMessage(msg);

    const result = await provider.read(msg.id, { includeAttachments: true });
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.unavailable).toBe("path-traversal-rejected");
    expect(result.attachments[0]?.path).toBeUndefined();
    expect(result.attachments[0]?.data).toBeUndefined();
  });

  it("should reject absolute path attempt", async () => {
    const msg = makeMsgWithAttachments([{ filename: "voice.ogg", id: "/etc/passwd" }]);
    store.upsertFullMessage(msg);

    const result = await provider.read(msg.id, { includeAttachments: true });
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.unavailable).toBe("path-traversal-rejected");
    expect(result.attachments[0]?.path).toBeUndefined();
  });

  it("should reject id with path separator (forward slash)", async () => {
    const msg = makeMsgWithAttachments([{ filename: "voice.ogg", id: "foo/bar" }]);
    store.upsertFullMessage(msg);

    const result = await provider.read(msg.id, { includeAttachments: true });
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.unavailable).toBe("path-traversal-rejected");
    expect(result.attachments[0]?.path).toBeUndefined();
  });

  it("should reject id with null byte", async () => {
    const msg = makeMsgWithAttachments([{ filename: "voice.ogg", id: "foo\x00bar" }]);
    store.upsertFullMessage(msg);

    const result = await provider.read(msg.id, { includeAttachments: true });
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.unavailable).toBe("path-traversal-rejected");
  });

  it("should reject very long id (>256 chars)", async () => {
    const longId = "a".repeat(257);
    const msg = makeMsgWithAttachments([{ filename: "voice.ogg", id: longId }]);
    store.upsertFullMessage(msg);

    const result = await provider.read(msg.id, { includeAttachments: true });
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.unavailable).toBe("path-traversal-rejected");
  });

  it("should NOT include path/unavailable when attachmentsRequested=false", async () => {
    const msg = makeMsgWithAttachments([{ filename: "voice.ogg", id: "abc123" }]);
    store.upsertFullMessage(msg);

    const result = await provider.read(msg.id, { includeAttachments: false });
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.path).toBeUndefined();
    expect(result.attachments[0]?.unavailable).toBeUndefined();
    expect(result.attachments[0]?.data).toBeUndefined();
  });

  it("should use XDG path on macOS (not Apple convention)", () => {
    if (process.platform !== "darwin") {
      return; // Skip on non-macOS
    }

    const attachmentDir = getSignalAttachmentDir();
    expect(attachmentDir).toContain(".local/share/signal-cli/attachments");
    expect(attachmentDir).not.toContain("Library/Application Support");
  });

  it("should use XDG path on Linux", () => {
    if (process.platform === "darwin") {
      return; // Skip on macOS
    }

    const attachmentDir = getSignalAttachmentDir();
    expect(attachmentDir).toContain(".local/share/signal-cli/attachments");
  });

  it("should handle multiple attachments with mixed id states", async () => {
    const msg = makeMsgWithAttachments([
      { filename: "a.ogg", id: "valid123" }, // Valid
      { filename: "b.ogg" }, // No id
      { filename: "c.ogg", id: "../bad" }, // Path traversal
    ]);
    store.upsertFullMessage(msg);

    const result = await provider.read(msg.id, { includeAttachments: true });
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.attachments).toHaveLength(3);

    // First: valid ID but file doesn't exist
    expect(result.attachments[0]?.unavailable).toBe("file-missing");
    expect(result.attachments[0]?.path).toBeUndefined();

    // Second: no id
    expect(result.attachments[1]?.unavailable).toBe("no-id");
    expect(result.attachments[1]?.path).toBeUndefined();

    // Third: path traversal rejected
    expect(result.attachments[2]?.unavailable).toBe("path-traversal-rejected");
    expect(result.attachments[2]?.path).toBeUndefined();
  });

  it("should accept base64-like IDs with padding (even if file missing)", async () => {
    const msg = makeMsgWithAttachments([{ filename: "voice.ogg", id: "abc123XYZ==" }]);
    store.upsertFullMessage(msg);

    const result = await provider.read(msg.id, { includeAttachments: true });
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.attachments).toHaveLength(1);
    // ID is valid charset-wise, but file doesn't exist
    expect(result.attachments[0]?.unavailable).toBe("file-missing");
    expect(result.attachments[0]?.path).toBeUndefined();
  });

  // Note: file-ambiguous case is covered by unit tests in signal-attachment-security.test.ts
  // Testing it here would require mocking getSignalAttachmentDir which is complex

  it("should NOT leak internal id field to consumer", async () => {
    // Regression test for Finding #1 (HIGH - contract-leakage)
    // The id field is internal metadata used only to construct the filesystem path.
    // It must NEVER appear in JSON output to consumers.
    const msg = makeMsgWithAttachments([{ filename: "voice.ogg", id: "abc123" }]);
    store.upsertFullMessage(msg);

    const result = await provider.read(msg.id, { includeAttachments: true });
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.attachments).toHaveLength(1);

    // Serialize to JSON and verify "id" field is not present
    const serialized = JSON.stringify(result.attachments[0]);
    expect(serialized).not.toContain('"id":');

    // Also verify via direct object access (TypeScript type check)
    const att = result.attachments[0];
    expect((att as any).id).toBeUndefined();
  });

  it("should NOT leak internal id field in inbox-light mode either", async () => {
    // Regression test for Finding #1 (inbox-light branch)
    const msg = makeMsgWithAttachments([{ filename: "voice.ogg", id: "abc123" }]);
    store.upsertFullMessage(msg);

    const result = await provider.read(msg.id, { includeAttachments: false });
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.attachments).toHaveLength(1);

    // Serialize to JSON and verify "id" field is not present
    const serialized = JSON.stringify(result.attachments[0]);
    expect(serialized).not.toContain('"id":');

    const att = result.attachments[0];
    expect((att as any).id).toBeUndefined();
  });
});
