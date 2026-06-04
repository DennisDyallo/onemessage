/**
 * Unit tests for SMS direction detection via production toSmsMessage().
 *
 * toSmsMessage() receives an explicit "direction" field from the
 * kdeconnect-read-sms JSON output and propagates it directly to
 * the MessageFull object it returns — no inference required.
 *
 * These tests verify the mapping and that from/to contacts are
 * set correctly for each direction.
 */
import { describe, expect, test } from "bun:test";
import { cacheSentMessage } from "../../providers/shared.ts";
import {
  pruneOptimisticSmsSentDuplicates,
  smsProvider,
  toSmsMessage,
} from "../../providers/sms.ts";
import * as store from "../../store.ts";
import type { MessageEnvelope, MessageFull } from "../../types.ts";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();

describe("SMS toSmsMessage direction", () => {
  test("incoming SMS has direction 'in'", () => {
    const msg = toSmsMessage({
      id: "1001",
      contact: "+46711111111",
      body: "Hey there",
      timestamp: NOW,
      direction: "in",
      read: false,
    });
    expect(msg.direction).toBe("in");
  });

  test("outgoing SMS has direction 'out'", () => {
    const msg = toSmsMessage({
      id: "1002",
      contact: "+46722222222",
      body: "Reply here",
      timestamp: NOW,
      direction: "out",
      read: true,
    });
    expect(msg.direction).toBe("out");
  });

  test("incoming SMS — from is the contact, to is 'me'", () => {
    const msg = toSmsMessage({
      id: "1003",
      contact: "+46733333333",
      body: "Incoming text",
      timestamp: NOW,
      direction: "in",
      read: false,
    });
    expect(msg.from?.address).toBe("+46733333333");
    expect(msg.to[0]?.address).toBe("me");
  });

  test("outgoing SMS — from is 'me', to is the contact", () => {
    const msg = toSmsMessage({
      id: "1004",
      contact: "+46744444444",
      body: "Outgoing text",
      timestamp: NOW,
      direction: "out",
      read: true,
    });
    expect(msg.from?.address).toBe("me");
    expect(msg.to[0]?.address).toBe("+46744444444");
  });

  test("unread flag is set correctly for incoming unread", () => {
    const msg = toSmsMessage({
      id: "1005",
      contact: "+46755555555",
      body: "Unread msg",
      timestamp: NOW,
      direction: "in",
      read: false,
    });
    expect(msg.unread).toBe(true);
  });

  test("unread flag is false for read messages", () => {
    const msg = toSmsMessage({
      id: "1006",
      contact: "+46766666666",
      body: "Read msg",
      timestamp: NOW,
      direction: "in",
      read: true,
    });
    expect(msg.unread).toBe(false);
  });

  test("preview is truncated to 100 chars", () => {
    const longBody = "A".repeat(200);
    const msg = toSmsMessage({
      id: "1007",
      contact: "+46777777777",
      body: longBody,
      timestamp: NOW,
      direction: "in",
      read: true,
    });
    expect(msg.preview.length).toBe(100);
    expect(msg.body.length).toBe(200);
  });

  test("provider is always 'sms'", () => {
    const msg = toSmsMessage({
      id: "1008",
      contact: "+46788888888",
      body: "test",
      timestamp: NOW,
      direction: "out",
      read: true,
    });
    expect(msg.provider).toBe("sms");
  });
});

// ---------------------------------------------------------------------------
// Contact name enrichment
// ---------------------------------------------------------------------------

describe("SMS contact name enrichment", () => {
  test("outgoing SMS uses contact name from lookup when available", () => {
    const contactNames = new Map([["+46711111111", "Alice"]]);
    const msg = toSmsMessage({
      id: "2001",
      contact: "+46711111111",
      body: "Hey Alice",
      timestamp: NOW,
      direction: "out",
      read: true,
      contactNames,
    });
    expect(msg.to[0]?.name).toBe("Alice");
    expect(msg.to[0]?.address).toBe("+46711111111");
  });

  test("outgoing SMS falls back to raw contact when no name exists", () => {
    const contactNames = new Map<string, string>();
    const msg = toSmsMessage({
      id: "2002",
      contact: "+46799999999",
      body: "Hello",
      timestamp: NOW,
      direction: "out",
      read: true,
      contactNames,
    });
    expect(msg.to[0]?.name).toBe("+46799999999");
    expect(msg.to[0]?.address).toBe("+46799999999");
  });

  test("incoming SMS uses contact name for from field", () => {
    const contactNames = new Map([["+46711111111", "Alice"]]);
    const msg = toSmsMessage({
      id: "2003",
      contact: "+46711111111",
      body: "Hello from Alice",
      timestamp: NOW,
      direction: "in",
      read: false,
      contactNames,
    });
    expect(msg.from?.name).toBe("Alice");
    expect(msg.from?.address).toBe("+46711111111");
    expect(msg.to[0]?.name).toBe("me");
  });

  test("incoming SMS without contact name falls back to raw contact", () => {
    const msg = toSmsMessage({
      id: "2004",
      contact: "+46799999999",
      body: "Unknown sender",
      timestamp: NOW,
      direction: "in",
      read: false,
    });
    expect(msg.from?.name).toBe("+46799999999");
    expect(msg.from?.address).toBe("+46799999999");
  });
});

describe("SMS sent cache reconciliation", () => {
  function makeOptimisticSent(
    id: string,
    body: string,
    recipientId: string,
    date: string,
  ): MessageFull {
    return {
      id,
      provider: "sms",
      from: { name: "", address: "Pixel Test Device" },
      to: [{ name: "", address: recipientId }],
      preview: body,
      body,
      bodyFormat: "text",
      date,
      unread: false,
      hasAttachments: false,
      attachments: [],
      direction: "out",
    };
  }

  test("KDE-confirmed outgoing rows replace optimistic sent cache rows", () => {
    const unique = `__test_sms_sent_dedupe_${Date.now()}__`;
    const recipientId = "+15555550999";
    const canonicalId = `42:${Date.now()}`;
    const canonical: MessageFull = {
      id: canonicalId,
      provider: "sms",
      from: { name: "me", address: "me" },
      to: [{ name: recipientId, address: recipientId }],
      preview: unique,
      body: unique,
      bodyFormat: "text",
      date: new Date().toISOString(),
      unread: false,
      hasAttachments: false,
      attachments: [],
      direction: "out",
    };

    try {
      cacheSentMessage({
        provider: "sms",
        fromAddress: "Pixel Test Device",
        recipientId,
        body: unique,
      });

      store.upsertFullMessages([canonical], "42");
      pruneOptimisticSmsSentDuplicates([canonical]);

      const matches = store.searchCached(unique, "sms", { limit: 10 });
      expect(matches.map((message) => message.id)).toEqual([canonicalId]);
    } finally {
      const ids = store.searchCached(unique, "sms", { limit: 10 }).map((message) => message.id);
      store.deleteMessages("sms", [...ids, canonicalId]);
    }
  });

  test("dedupe removes only the closest optimistic row for repeated identical texts", () => {
    const unique = `__test_sms_sent_repeat_${Date.now()}__`;
    const recipientId = "+15555550888";
    const canonicalId = `43:${Date.now()}`;
    const canonicalDate = new Date().toISOString();
    const closeOptimisticId = `${unique}:close`;
    const olderOptimisticId = `${unique}:older`;
    const canonical: MessageFull = {
      id: canonicalId,
      provider: "sms",
      from: { name: "me", address: "me" },
      to: [{ name: recipientId, address: recipientId }],
      preview: unique,
      body: unique,
      bodyFormat: "text",
      date: canonicalDate,
      unread: false,
      hasAttachments: false,
      attachments: [],
      direction: "out",
    };

    try {
      store.upsertFullMessages([
        makeOptimisticSent(closeOptimisticId, unique, recipientId, canonicalDate),
        makeOptimisticSent(
          olderOptimisticId,
          unique,
          recipientId,
          new Date(Date.now() - 5 * 60_000).toISOString(),
        ),
      ]);

      store.upsertFullMessages([canonical], "43");
      pruneOptimisticSmsSentDuplicates([canonical]);

      expect(store.getCachedMessage("sms", closeOptimisticId)).toBeNull();
      expect(store.getCachedMessage("sms", olderOptimisticId)?.id).toBe(olderOptimisticId);
      expect(store.getCachedMessage("sms", canonicalId)?.id).toBe(canonicalId);
    } finally {
      store.deleteMessages("sms", [closeOptimisticId, olderOptimisticId, canonicalId]);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3a: inbox() migration to inboxViaDaemon
// ---------------------------------------------------------------------------

describe("SMS inbox() — inboxViaDaemon migration", () => {
  test("inbox() returns fresh cache without daemon call when cache is fresh", async () => {
    // This test proves the freshness gate works: when cache is fresh,
    // inbox() should return cached data immediately without triggering daemon.
    //
    // Strategy: Seed cache with a known SMS message, mark as fresh,
    // call inbox() with fresh:false, assert cached message returns.
    // If the helper's freshness gate is broken, this would timeout
    // waiting for daemon (which we're not mocking).

    const testId = "__test_sms_inbox_fresh__:1";
    const testMsg: MessageFull = {
      id: testId,
      provider: "sms",
      from: { name: "Test Contact", address: "+15555550101" },
      to: [{ name: "Me", address: "+15555550199" }],
      preview: "cached sms inbox message",
      body: "cached sms inbox message",
      bodyFormat: "text",
      date: new Date().toISOString(),
      unread: true,
      hasAttachments: false,
      attachments: [],
      direction: "in",
    };
    try {
      store.upsertFullMessages([testMsg]);

      // Mark cache as FRESH (within provider freshness window)
      store.recordFetch("sms");

      // Act: call inbox() with fresh:false
      // This should short-circuit at the freshness gate and NOT call daemon
      const result = await smsProvider.inbox({
        fresh: false,
        limit: 10,
      });

      // Assert: should return the cached message WITHOUT timeout (proves freshness gate works)
      expect(result.length).toBeGreaterThan(0);
      const found = result.find((m: MessageEnvelope) => m.id === testId);
      expect(found).toBeDefined();
      expect(found?.preview).toBe("cached sms inbox message");
    } finally {
      store.deleteMessages("sms", [testId]);
    }
  });

  test("inbox() calls inboxViaDaemon (structural proof of migration)", async () => {
    // This test proves the migration happened by inspecting the source code structure.
    // The old implementation called `fetchSmsInbox` and `store.isFresh` directly.
    // The new implementation calls `inboxViaDaemon` (helper that manages daemon lifecycle).
    //
    // Strategy: Read the inbox() source, assert it contains "inboxViaDaemon" and NOT the old direct calls.

    const fs = await import("node:fs/promises");
    const smsProviderSource = await fs.readFile(
      new URL("../../providers/sms.ts", import.meta.url),
      "utf-8",
    );

    // Extract the inbox() method body
    const inboxMatch = smsProviderSource.match(/async inbox\(opts\)\s*{[\s\S]*?^ {2}},/m);
    expect(inboxMatch).not.toBeNull();

    const inboxBody = (inboxMatch?.[0] ?? "")
      .replace(/\/\/.*$/gm, "") // strip line comments
      .replace(/\/\*[\s\S]*?\*\//g, ""); // strip block comments

    // Assert: inbox() calls inboxViaDaemon
    expect(inboxBody).toContain("inboxViaDaemon");

    // Assert: inbox() keeps fetch work behind inboxViaDaemon's fallback path.
    expect(inboxBody).toContain("fallbackFetch");

    // Assert: inbox() does NOT call store.isFresh directly inside inbox()
    expect(inboxBody).not.toContain("store.isFresh");

    // Assert: inbox() passes provider:"sms" to helper
    expect(inboxBody).toContain('provider: "sms"');

    // Assert: inbox() uses provider-specific cache policy
    expect(inboxBody).toContain('freshnessMs: getProviderFreshnessMs("sms")');
  });
});

describe("SmsAdapter configuration convention", () => {
  test("daemon active state accepts internal DBus reader", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("../../daemons/sms.ts", import.meta.url), "utf-8");

    expect(source).toContain("resolveSmsSettings() !== null");
    expect(source).toContain('cliExists("dbus-send")');
  });

  test("provider DBus reader preserves KDE refresh semantics", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("../../providers/sms.ts", import.meta.url), "utf-8");

    expect(source).toContain("requestSmsRefreshViaDbus");
    expect(source).toContain("requestAllConversationThreads");
    expect(source).toContain("activeConversations");
  });

  test("provider DBus reader supports full thread history", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("../../providers/sms.ts", import.meta.url), "utf-8");

    expect(source).toContain("fetchThreadHistoryViaDbus");
    expect(source).toContain("dbus-monitor");
    expect(source).toContain("requestConversation");
  });
});
