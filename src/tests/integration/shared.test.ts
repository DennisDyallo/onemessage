/**
 * Unit + integration tests for shared provider utilities.
 *
 * Tests readFromCacheOrFail and cacheSentMessage against the real store.
 * Uses a unique provider name to avoid collisions with real data.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheSentMessage,
  normalizeRecipientForProvider,
  readFromCacheOrFail,
  replyViaSend,
  resolveDefaultReply,
} from "../../providers/shared.ts";
import * as store from "../../store.ts";
import type { MessageFull, MessagingProvider, SendOptions, SendResult } from "../../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PROVIDER = "__test_shared__";
let counter = 0;

function uniqueId(): string {
  counter++;
  return `shared-test-${Date.now()}-${counter}`;
}

function makeFull(id: string, extras?: Partial<MessageFull>): MessageFull {
  return {
    id,
    provider: TEST_PROVIDER,
    from: { name: "Sender", address: "sender-addr" },
    to: [{ name: "Recipient", address: "recipient-addr" }],
    preview: "test preview",
    body: "test body",
    bodyFormat: "text",
    date: new Date().toISOString(),
    unread: false,
    hasAttachments: false,
    attachments: [],
    direction: "in",
    ...extras,
  };
}

// ---------------------------------------------------------------------------
// readFromCacheOrFail
// ---------------------------------------------------------------------------

describe("readFromCacheOrFail", () => {
  test("returns cached message when it exists in the store", () => {
    const id = uniqueId();
    const msg = makeFull(id);
    store.upsertFullMessages([msg]);

    const result = readFromCacheOrFail(TEST_PROVIDER, id);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(id);
    expect(result?.body).toBe("test body");
  });

  test("returns null when message is not cached", () => {
    const result = readFromCacheOrFail(TEST_PROVIDER, "nonexistent-id-12345");
    expect(result).toBeNull();
  });

  test("returns null for nonexistent provider", () => {
    const result = readFromCacheOrFail("__no_such_provider__", "any-id");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recipient normalization
// ---------------------------------------------------------------------------

describe("recipient normalization", () => {
  test("normalizes Swedish E.164-like phone numbers for WhatsApp", () => {
    expect(normalizeRecipientForProvider("whatsapp", "46728418689")).toEqual({
      ok: true,
      recipientId: "+46728418689",
    });
  });

  test("normalizes Swedish local phone numbers for all phone-like providers", () => {
    for (const provider of ["whatsapp", "signal", "sms"]) {
      expect(normalizeRecipientForProvider(provider, "072-841 86 89")).toEqual({
        ok: true,
        recipientId: "+46728418689",
      });
    }
  });

  test("preserves provider-native group and JID recipient formats", () => {
    expect(normalizeRecipientForProvider("whatsapp", "group:Family").recipientId).toBe(
      "group:Family",
    );
    expect(normalizeRecipientForProvider("whatsapp", "123@g.us").recipientId).toBe("123@g.us");
  });

  test("rejects ambiguous bare phone numbers with precise E.164 guidance", () => {
    const result = normalizeRecipientForProvider("signal", "728418689");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Use E.164 format");
  });

  test("does not phone-normalize non-phone providers", () => {
    expect(normalizeRecipientForProvider("email", "person@example.com")).toEqual({
      ok: true,
      recipientId: "person@example.com",
    });
  });
});

// ---------------------------------------------------------------------------
// cacheSentMessage
// ---------------------------------------------------------------------------

describe("cacheSentMessage", () => {
  test("creates an outgoing envelope in the store with direction='out'", () => {
    const id = uniqueId();
    cacheSentMessage({
      provider: TEST_PROVIDER,
      messageId: id,
      fromAddress: "me",
      recipientId: "them",
      body: "outgoing message",
    });

    const stored = store.getCachedMessage(TEST_PROVIDER, id);
    expect(stored).not.toBeNull();
    expect(stored?.direction).toBe("out");
  });

  test("uses provided messageId", () => {
    const id = uniqueId();
    cacheSentMessage({
      provider: TEST_PROVIDER,
      messageId: id,
      fromAddress: "me",
      recipientId: "them",
      body: "hello",
    });

    const stored = store.getCachedMessage(TEST_PROVIDER, id);
    expect(stored).not.toBeNull();
    expect(stored?.id).toBe(id);
  });

  test("sets provider and from fields correctly", () => {
    const id = uniqueId();
    cacheSentMessage({
      provider: TEST_PROVIDER,
      messageId: id,
      fromAddress: "bot-address",
      recipientId: "user-address",
      body: "check fields",
    });

    const stored = store.getCachedMessage(TEST_PROVIDER, id);
    expect(stored).not.toBeNull();
    expect(stored?.provider).toBe(TEST_PROVIDER);
    expect(stored?.from?.address).toBe("bot-address");
  });

  test("body is stored in preview", () => {
    const id = uniqueId();
    cacheSentMessage({
      provider: TEST_PROVIDER,
      messageId: id,
      fromAddress: "me",
      recipientId: "them",
      body: "this should be the preview",
    });

    const stored = store.getCachedMessage(TEST_PROVIDER, id);
    expect(stored).not.toBeNull();
    expect(stored?.preview).toBe("this should be the preview");
  });
});

// ---------------------------------------------------------------------------
// reply helpers
// ---------------------------------------------------------------------------

describe("reply helpers", () => {
  test("resolveDefaultReply targets the original sender", () => {
    const original = makeFull(uniqueId(), {
      from: { name: "Original Sender", address: "sender@example.com" },
    });

    expect(resolveDefaultReply(original)).toEqual({ recipientId: "sender@example.com" });
  });

  test("resolveDefaultReply rejects messages without sender addresses", () => {
    const original = makeFull(uniqueId(), { from: null });

    expect(() => resolveDefaultReply(original)).toThrow("no sender or conversation address");
  });

  test("resolveDefaultReply targets the conversation for group messages", () => {
    const original = makeFull(uniqueId(), {
      from: { name: "Group Sender", address: "sender-id" },
      to: [{ name: "Group", address: "group-id" }],
      isGroup: true,
    });

    expect(resolveDefaultReply(original)).toEqual({ recipientId: "group-id" });
  });

  test("resolveDefaultReply targets Signal-style group IDs stored as sender", () => {
    const original = makeFull(uniqueId(), {
      from: { name: "Sender [Group]", address: "group:signal-group-id" },
      to: [],
      isGroup: true,
      groupName: "Group",
    });

    expect(resolveDefaultReply(original)).toEqual({ recipientId: "group:signal-group-id" });
  });

  test("resolveDefaultReply targets WhatsApp-style group names when addressed to self", () => {
    const original = makeFull(uniqueId(), {
      from: { name: "Participant", address: "participant-id" },
      to: [{ name: "me", address: "me" }],
      isGroup: true,
      groupName: "Family Chat",
    });

    expect(resolveDefaultReply(original)).toEqual({ recipientId: "group:Family Chat" });
  });

  test("resolveDefaultReply targets the peer for outbound direct messages", () => {
    const original = makeFull(uniqueId(), {
      from: { name: "Me", address: "me" },
      to: [{ name: "Peer", address: "peer-id" }],
      direction: "out",
    });

    expect(resolveDefaultReply(original)).toEqual({ recipientId: "peer-id" });
  });

  test("replyViaSend delegates to provider.send with shared reply target", async () => {
    const id = uniqueId();
    store.upsertFullMessages([
      makeFull(id, { from: { name: "Sender", address: "sender@example.com" } }),
    ]);

    let captured: { recipientId: string; body: string; opts?: SendOptions } | null = null;
    const provider: MessagingProvider = {
      name: TEST_PROVIDER,
      displayName: "Test Provider",
      isConfigured: () => true,
      send: async (recipientId, body, opts): Promise<SendResult> => {
        captured = { recipientId, body, opts };
        return { ok: true, provider: TEST_PROVIDER, recipientId, messageId: "sent-1" };
      },
      inbox: async () => [],
      read: async () => null,
    };

    const result = await replyViaSend(provider, id, "reply body", { subject: "ignored" });

    expect(result.ok).toBe(true);
    expect(captured).not.toBeNull();
    const sent = captured as unknown as { recipientId: string; body: string; opts?: SendOptions };
    expect(sent.recipientId).toBe("sender@example.com");
    expect(sent.body).toBe("reply body");
    expect(sent.opts).toEqual({ subject: "ignored" });
  });

  test("replyViaSend targets the peer for outbound cached direct messages", async () => {
    const id = uniqueId();
    store.upsertFullMessages([
      makeFull(id, {
        from: { name: "Me", address: "me" },
        to: [{ name: "Peer", address: "peer-id" }],
        direction: "out",
      }),
    ]);

    let capturedRecipient = "";
    const provider: MessagingProvider = {
      name: TEST_PROVIDER,
      displayName: "Test Provider",
      isConfigured: () => true,
      send: async (recipientId): Promise<SendResult> => {
        capturedRecipient = recipientId;
        return { ok: true, provider: TEST_PROVIDER, recipientId, messageId: "sent-outbound" };
      },
      inbox: async () => [],
      read: async () => null,
    };

    const result = await replyViaSend(provider, id, "reply body");

    expect(result.ok).toBe(true);
    expect(capturedRecipient).toBe("peer-id");
  });

  test("replyViaSend reads --file bodies for providers without native file handling", async () => {
    const id = uniqueId();
    store.upsertFullMessages([
      makeFull(id, { from: { name: "Sender", address: "sender@example.com" } }),
    ]);
    const dir = mkdtempSync(join(tmpdir(), "onemessage-reply-test-"));
    const filePath = join(dir, "reply.txt");
    writeFileSync(filePath, "body from file", "utf-8");

    let capturedBody = "";
    const provider: MessagingProvider = {
      name: TEST_PROVIDER,
      displayName: "Test Provider",
      isConfigured: () => true,
      send: async (recipientId, body): Promise<SendResult> => {
        capturedBody = body;
        return { ok: true, provider: TEST_PROVIDER, recipientId, messageId: "sent-2" };
      },
      inbox: async () => [],
      read: async () => null,
    };

    const result = await replyViaSend(provider, id, "", { file: filePath });

    expect(result.ok).toBe(true);
    expect(capturedBody).toBe("body from file");
  });
});

// ---------------------------------------------------------------------------
// inboxViaDaemon
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// inboxViaDaemon
// ---------------------------------------------------------------------------

describe("inboxViaDaemon", () => {
  const TEST_IVD_PROVIDER = "__test_ivd__";

  test("returns cache when fresh, daemon not needed", async () => {
    const { inboxViaDaemon } = await import("../../providers/shared.ts");
    const id = uniqueId();
    const msg = makeFull(id, { provider: TEST_IVD_PROVIDER });
    store.upsertFullMessages([msg]);
    store.recordFetch(TEST_IVD_PROVIDER); // Makes cache fresh

    // With fresh cache, should return immediately without daemon interaction
    const result = await inboxViaDaemon({
      provider: TEST_IVD_PROVIDER,
      freshnessMs: 60_000,
      fresh: false,
      cacheArgs: { limit: 10 },
    });

    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.id).toBe(id);
  });

  test("fresh:true bypasses cache", async () => {
    const { inboxViaDaemon } = await import("../../providers/shared.ts");
    const provider = `${TEST_IVD_PROVIDER}_bypass`;
    const id = uniqueId();
    store.upsertFullMessages([makeFull(id, { provider })]);
    store.recordFetch(provider);

    const orig = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      await inboxViaDaemon({
        provider,
        freshnessMs: 60_000,
        fresh: true,
        cacheArgs: { limit: 10 },
      });
      expect(warned).toBe(true); // Daemon attempt happened (and failed)
    } finally {
      console.warn = orig;
    }
  });

  test("account and folder params thread through", async () => {
    const { inboxViaDaemon } = await import("../../providers/shared.ts");
    const provider = `${TEST_IVD_PROVIDER}_acct`;
    const account = "acc1";

    // CRITICAL: Record FRESH fetch for the DEFAULT folder ("") — this is the trap
    // If folder is silently ignored, isFresh will look up ("", account, "") which IS fresh
    // → cache short-circuit → NO warn → test FAILS as it should
    store.recordFetch(provider, account, "");

    // Also record fresh INBOX (to show that multiple folders can be fresh)
    store.recordFetch(provider, account, "INBOX");

    // Record STALE fetch for Spam folder (2 hours old, well beyond 60s freshness)
    const db = store.getDb();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT OR REPLACE INTO fetch_log (provider, account, folder, fetched_at) VALUES (?, ?, ?, ?)",
    ).run(provider, account, "Spam", twoHoursAgo);

    const orig = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };

    try {
      // Call with folder: "Spam" — should trigger daemon because Spam IS stale
      // If folder ignored: would look up (provider, account, "") which IS FRESH
      //   → cache short-circuit → NO warn → test FAILS ❌
      // If folder respected: looks up (provider, account, "Spam") which is STALE
      //   → daemon path → warn → test PASSES ✅
      const result = await inboxViaDaemon({
        provider,
        freshnessMs: 60_000,
        account,
        folder: "Spam", // Stale folder
        fresh: false,
        cacheArgs: { limit: 10 },
      });

      // The KEY observable: daemon path was triggered (not cache short-circuit)
      expect(warned).toBe(true);
      expect(Array.isArray(result)).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  test("no throw on daemon failure", async () => {
    const { inboxViaDaemon } = await import("../../providers/shared.ts");
    const provider = `${TEST_IVD_PROVIDER}_fail`;
    const id = uniqueId();
    store.upsertFullMessages([makeFull(id, { provider })]);
    const orig = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      const result = await inboxViaDaemon({
        provider,
        freshnessMs: 60_000,
        fresh: false,
        cacheArgs: { limit: 10 },
      });
      expect(result.length).toBeGreaterThan(0);
      expect(warned).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  test("fallbackFetch runs once on daemon error", async () => {
    const { inboxViaDaemon } = await import("../../providers/shared.ts");
    const provider = `${TEST_IVD_PROVIDER}_fb`;
    let calls = 0;
    await inboxViaDaemon({
      provider,
      freshnessMs: 60_000,
      fresh: false,
      cacheArgs: { limit: 10 },
      fallbackFetch: async () => {
        calls++;
        store.upsertFullMessages([makeFull(uniqueId(), { provider })]);
      },
    });
    expect(calls).toBe(1);
  });

  test("fallbackFetch errors are caught", async () => {
    const { inboxViaDaemon } = await import("../../providers/shared.ts");
    const provider = `${TEST_IVD_PROVIDER}_throw`;
    let calls = 0;
    const orig = console.warn;
    let warned = false;
    console.warn = (msg: string) => {
      if (msg.includes("fallback")) warned = true;
    };
    try {
      await inboxViaDaemon({
        provider,
        freshnessMs: 60_000,
        fresh: false,
        cacheArgs: { limit: 10 },
        fallbackFetch: async () => {
          calls++;
          throw new Error("boom");
        },
      });
      expect(calls).toBe(1);
      expect(warned).toBe(true);
    } finally {
      console.warn = orig;
    }
  });
});
