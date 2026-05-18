/**
 * Tests for parseSignalMessages edge cases.
 *
 * Specifically guards against the `??` empty-array bug where the parser
 * preferred dataMessage.attachments even when it was empty, dropping real
 * attachments that only appeared in syncMessage.
 */

import { describe, expect, it } from "bun:test";
import { parseSignalMessages } from "./signal";

function makeEnvelope(opts: {
  dataAttachments?: Array<{ id?: string; contentType?: string; filename?: string; size?: number }>;
  syncAttachments?: Array<{ id?: string; contentType?: string; filename?: string; size?: number }>;
  syncDestination?: string;
}): string {
  const envelope: Record<string, unknown> = {
    source: "+15550001111",
    sourceNumber: "+15550001111",
    sourceName: "Test Source",
    timestamp: 1700000000000,
  };
  if (opts.dataAttachments !== undefined) {
    envelope.dataMessage = {
      timestamp: 1700000000000,
      message: null,
      attachments: opts.dataAttachments,
    };
  }
  if (opts.syncAttachments !== undefined) {
    envelope.syncMessage = {
      sentMessage: {
        timestamp: 1700000000000,
        message: null,
        destinationNumber: opts.syncDestination ?? "+15550002222",
        attachments: opts.syncAttachments,
      },
    };
  }
  return JSON.stringify({ envelope });
}

describe("parseSignalMessages attachment preference", () => {
  it("uses dataMessage.attachments when populated and syncMessage absent", () => {
    const line = makeEnvelope({
      dataAttachments: [{ id: "abc123", contentType: "audio/aac", size: 100 }],
    });
    const messages = parseSignalMessages(line);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.hasAttachments).toBe(true);
    expect(messages[0]?.attachments).toHaveLength(1);
    expect((messages[0]?.attachments[0] as { id?: string }).id).toBe("abc123");
  });

  it("uses syncMessage.attachments when dataMessage absent", () => {
    const line = makeEnvelope({
      syncAttachments: [{ id: "sync456", contentType: "audio/aac", size: 200 }],
    });
    const messages = parseSignalMessages(line);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.hasAttachments).toBe(true);
    expect(messages[0]?.attachments).toHaveLength(1);
    expect((messages[0]?.attachments[0] as { id?: string }).id).toBe("sync456");
  });

  it("BUG A regression: prefers syncMessage.attachments when dataMessage.attachments is empty array", () => {
    // The `??` operator was preferring dataMessage.attachments (an empty array)
    // even when syncMessage carried the real attachments. This dropped the data
    // while still setting hasAttachments=true (since syncMessage.length > 0).
    const line = makeEnvelope({
      dataAttachments: [], // explicitly empty
      syncAttachments: [{ id: "real-from-sync", contentType: "audio/aac", size: 300 }],
    });
    const messages = parseSignalMessages(line);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.hasAttachments).toBe(true);
    expect(messages[0]?.attachments).toHaveLength(1);
    expect((messages[0]?.attachments[0] as { id?: string }).id).toBe("real-from-sync");
  });

  it("returns empty attachments and hasAttachments=false when neither side has any", () => {
    const line = makeEnvelope({ dataAttachments: [] });
    const messages = parseSignalMessages(line);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.hasAttachments).toBe(false);
    expect(messages[0]?.attachments).toHaveLength(0);
  });
});
