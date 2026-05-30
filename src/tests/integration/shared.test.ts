/**
 * Unit + integration tests for shared provider utilities.
 *
 * Tests readFromCacheOrFail and cacheSentMessage against the real store.
 * Uses a unique provider name to avoid collisions with real data.
 */
import { describe, expect, test } from "bun:test";
import { cacheSentMessage, readFromCacheOrFail } from "../../providers/shared.ts";
import * as store from "../../store.ts";
import type { MessageFull } from "../../types.ts";

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
