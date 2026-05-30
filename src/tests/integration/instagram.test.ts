/**
 * Unit tests for Instagram direction detection and read() --fresh path.
 *
 * Instagram uses isOutgoing from the instagram-cli JSON output to determine
 * message direction via readMessageToFull(). The fresh path in read() calls
 * fetchThreadMessages() to backfill uncached sub-messages before returning
 * from cache.
 *
 * Tests here cover:
 * 1. isOutgoing → direction mapping via readMessageToFull replica
 * 2. The --fresh branch calls fetchThreadMessages and upserts results
 * 3. Edge cases (media-only, no text)
 */
import { describe, expect, test } from "bun:test";
import type { MessageFull } from "../../types.ts";

// ---------------------------------------------------------------------------
// Inline replica of readMessageToFull() from instagram.ts
// ---------------------------------------------------------------------------

interface ReadMessage {
  id: string;
  itemType: string;
  text?: string;
  media?: { id: string; mediaType: number };
  userId: string;
  username: string;
  timestamp: string;
  isOutgoing: boolean;
}

function readMessageToFull(msg: ReadMessage, threadId: string, threadTitle: string): MessageFull {
  const from = msg.isOutgoing
    ? { name: "me", address: "me" }
    : { name: threadTitle || msg.username, address: msg.username };
  const to = msg.isOutgoing
    ? [{ name: threadTitle, address: threadId }]
    : [{ name: "me", address: "me" }];

  return {
    id: msg.id,
    provider: "instagram",
    from,
    to,
    preview: msg.text ?? `[${msg.itemType}]`,
    body: msg.text ?? `[${msg.itemType}]`,
    bodyFormat: "text",
    date: msg.timestamp,
    unread: false,
    hasAttachments: msg.media !== undefined,
    attachments: [],
    direction: msg.isOutgoing ? "out" : "in",
  };
}

// ---------------------------------------------------------------------------
// The --fresh read() logic (replica of what instagram.ts read() does)
// ---------------------------------------------------------------------------

interface FetchAndUpsertResult {
  fetchedThreadId: string | null;
  upsertedIn: MessageFull[];
  upsertedOut: MessageFull[];
}

async function simulateFreshRead(
  messageId: string,
  fetchThreadMessages: (id: string) => Promise<MessageFull[]>,
  upsertFullMessages: (msgs: MessageFull[], dir: "in" | "out", threadId: string) => void,
): Promise<FetchAndUpsertResult> {
  const result: FetchAndUpsertResult = {
    fetchedThreadId: null,
    upsertedIn: [],
    upsertedOut: [],
  };

  const messages = await fetchThreadMessages(messageId);
  result.fetchedThreadId = messageId;
  if (messages.length > 0) {
    const incoming = messages.filter((m) => m.from?.address !== "me");
    const outgoing = messages.filter((m) => m.from?.address === "me");
    if (incoming.length > 0) {
      upsertFullMessages(incoming, "in", messageId);
      result.upsertedIn = incoming;
    }
    if (outgoing.length > 0) {
      upsertFullMessages(outgoing, "out", messageId);
      result.upsertedOut = outgoing;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();

describe("Instagram readMessageToFull direction", () => {
  test("incoming message has direction 'in'", () => {
    const msg: ReadMessage = {
      id: "ig-msg-001",
      itemType: "text",
      text: "Hey!",
      userId: "123456",
      username: "alice",
      timestamp: NOW,
      isOutgoing: false,
    };
    const full = readMessageToFull(msg, "thread-abc", "alice");
    expect(full.direction).toBe("in");
  });

  test("outgoing message has direction 'out'", () => {
    const msg: ReadMessage = {
      id: "ig-msg-002",
      itemType: "text",
      text: "Hello back",
      userId: "self",
      username: "me",
      timestamp: NOW,
      isOutgoing: true,
    };
    const full = readMessageToFull(msg, "thread-abc", "alice");
    expect(full.direction).toBe("out");
  });

  test("incoming — from is the contact username, to is me", () => {
    const msg: ReadMessage = {
      id: "ig-msg-003",
      itemType: "text",
      text: "Hi",
      userId: "789",
      username: "bob",
      timestamp: NOW,
      isOutgoing: false,
    };
    const full = readMessageToFull(msg, "thread-xyz", "bob");
    expect(full.from?.address).toBe("bob");
    expect(full.to[0]?.address).toBe("me");
  });

  test("outgoing — from is 'me', to is the thread", () => {
    const msg: ReadMessage = {
      id: "ig-msg-004",
      itemType: "text",
      text: "Reply",
      userId: "self",
      username: "me",
      timestamp: NOW,
      isOutgoing: true,
    };
    const full = readMessageToFull(msg, "thread-xyz", "bob");
    expect(full.from?.address).toBe("me");
    expect(full.to[0]?.address).toBe("thread-xyz");
  });

  test("media-only message (no text) falls back to itemType in preview", () => {
    const msg: ReadMessage = {
      id: "ig-msg-005",
      itemType: "media",
      media: { id: "media-001", mediaType: 1 },
      userId: "123",
      username: "carol",
      timestamp: NOW,
      isOutgoing: false,
    };
    const full = readMessageToFull(msg, "thread-media", "carol");
    expect(full.preview).toBe("[media]");
    expect(full.hasAttachments).toBe(true);
    expect(full.direction).toBe("in");
  });

  test("link preview item type is preserved as body", () => {
    const msg: ReadMessage = {
      id: "ig-msg-006",
      itemType: "link",
      userId: "456",
      username: "dave",
      timestamp: NOW,
      isOutgoing: false,
    };
    const full = readMessageToFull(msg, "thread-link", "dave");
    expect(full.body).toBe("[link]");
    expect(full.direction).toBe("in");
  });
});

describe("Instagram read() --fresh path", () => {
  test("calls fetchThreadMessages with the messageId when fresh=true", async () => {
    const fetchedIds: string[] = [];
    const upsertedIn: MessageFull[] = [];
    const upsertedOut: MessageFull[] = [];

    const fetchThreadMessages = async (id: string): Promise<MessageFull[]> => {
      fetchedIds.push(id);
      return [
        readMessageToFull(
          {
            id: "sub-001",
            itemType: "text",
            text: "Hi",
            userId: "u1",
            username: "alice",
            timestamp: NOW,
            isOutgoing: false,
          },
          id,
          "alice",
        ),
      ];
    };

    const upsertFullMessages = (msgs: MessageFull[], dir: "in" | "out", _threadId: string) => {
      if (dir === "in") upsertedIn.push(...msgs);
      else upsertedOut.push(...msgs);
    };

    const result = await simulateFreshRead("thread-123", fetchThreadMessages, upsertFullMessages);

    expect(fetchedIds).toContain("thread-123");
    expect(result.fetchedThreadId).toBe("thread-123");
    expect(upsertedIn).toHaveLength(1);
    expect(upsertedOut).toHaveLength(0);
  });

  test("outgoing messages are upserted with direction 'out'", async () => {
    const upsertedIn: MessageFull[] = [];
    const upsertedOut: MessageFull[] = [];

    const fetchThreadMessages = async (id: string): Promise<MessageFull[]> => {
      return [
        readMessageToFull(
          {
            id: "out-001",
            itemType: "text",
            text: "Sent by me",
            userId: "self",
            username: "me",
            timestamp: NOW,
            isOutgoing: true,
          },
          id,
          "alice",
        ),
      ];
    };

    const upsertFullMessages = (msgs: MessageFull[], dir: "in" | "out", _threadId: string) => {
      if (dir === "in") upsertedIn.push(...msgs);
      else upsertedOut.push(...msgs);
    };

    await simulateFreshRead("thread-456", fetchThreadMessages, upsertFullMessages);

    expect(upsertedIn).toHaveLength(0);
    expect(upsertedOut).toHaveLength(1);
    expect(upsertedOut[0]?.direction).toBe("out");
  });

  test("empty fetch result does not upsert anything", async () => {
    const upsertedIn: MessageFull[] = [];
    const upsertedOut: MessageFull[] = [];

    const fetchThreadMessages = async (_id: string): Promise<MessageFull[]> => [];
    const upsertFullMessages = (msgs: MessageFull[], dir: "in" | "out", _threadId: string) => {
      if (dir === "in") upsertedIn.push(...msgs);
      else upsertedOut.push(...msgs);
    };

    await simulateFreshRead("thread-empty", fetchThreadMessages, upsertFullMessages);

    expect(upsertedIn).toHaveLength(0);
    expect(upsertedOut).toHaveLength(0);
  });

  test("mixed thread upserts incoming and outgoing separately", async () => {
    const upsertedIn: MessageFull[] = [];
    const upsertedOut: MessageFull[] = [];

    const fetchThreadMessages = async (id: string): Promise<MessageFull[]> => {
      return [
        readMessageToFull(
          {
            id: "mix-in-1",
            itemType: "text",
            text: "Incoming",
            userId: "u1",
            username: "alice",
            timestamp: NOW,
            isOutgoing: false,
          },
          id,
          "alice",
        ),
        readMessageToFull(
          {
            id: "mix-out-1",
            itemType: "text",
            text: "Outgoing",
            userId: "self",
            username: "me",
            timestamp: NOW,
            isOutgoing: true,
          },
          id,
          "alice",
        ),
      ];
    };

    const upsertFullMessages = (msgs: MessageFull[], dir: "in" | "out", _threadId: string) => {
      if (dir === "in") upsertedIn.push(...msgs);
      else upsertedOut.push(...msgs);
    };

    await simulateFreshRead("thread-mixed", fetchThreadMessages, upsertFullMessages);

    expect(upsertedIn).toHaveLength(1);
    expect(upsertedOut).toHaveLength(1);
    expect(upsertedIn[0]?.direction).toBe("in");
    expect(upsertedOut[0]?.direction).toBe("out");
  });
});

// ---------------------------------------------------------------------------
// inbox() migration — inboxViaDaemon integration
// ---------------------------------------------------------------------------

describe("instagramProvider.inbox via inboxViaDaemon", () => {
  // NOTE: This migration uses a structural test (source code regex) as the
  // revert guard instead of a behavioral test. Behavioral testing for this
  // migration is environment-dependent (requires Instagram auth config) and
  // would pass on both pre-migration and post-migration code when cache is
  // fresh. The helper itself (inboxViaDaemon) has behavioral unit tests in
  // shared.test.ts. This structural test proves the provider delegates to
  // that helper, which is a stronger migration guarantee than a flaky
  // behavioral test that could pass on revert.
  //
  // CRITICAL: This test performs ZERO live Instagram API calls. Instagram's
  // bot detection is aggressive and will ban the account (ddyallo) if tests
  // hit their endpoints. This is pure source inspection.

  test("inbox() calls inboxViaDaemon (structural proof of migration)", async () => {
    // This test proves the migration happened by inspecting the source code structure.
    // The old implementation called freshness checks and fetch directly.
    // The new implementation calls `inboxViaDaemon` (helper that manages daemon lifecycle).
    //
    // Strategy: Read the inbox() source, assert it contains "inboxViaDaemon" and NOT the old direct calls.

    const fs = await import("node:fs/promises");
    const instagramSource = await fs.readFile(
      new URL("../../providers/instagram.ts", import.meta.url),
      "utf-8",
    );

    // Extract the inbox() method body
    const inboxMatch = instagramSource.match(/async inbox\(opts\)\s*{[\s\S]*?^ {2}},/m);
    expect(inboxMatch).not.toBeNull();

    const inboxBody = inboxMatch?.[0] ?? "";

    // Assert: inbox() calls inboxViaDaemon
    expect(inboxBody).toContain("inboxViaDaemon");

    // Assert: inbox() does NOT call store.isFresh directly inside inbox()
    expect(inboxBody).not.toContain("store.isFresh");

    // Assert: inbox() does NOT call store.getCachedInbox directly (helper manages this)
    expect(inboxBody).not.toContain("store.getCachedInbox");

    // Assert: inbox() does NOT call fetchInstagramInbox directly inside inbox()
    expect(inboxBody).not.toContain("fetchInstagramInbox");

    // Assert: inbox() passes provider:"instagram" to helper
    expect(inboxBody).toContain('provider: "instagram"');

    // Assert: inbox() passes freshnessMs:300_000 to helper
    expect(inboxBody).toContain("freshnessMs: 300_000");

    // Assert: inbox() passes account:settings.username to helper
    expect(inboxBody).toContain("account: settings.username");
  });

  test("InstagramAdapter has MIN_FETCH_INTERVAL_MS rate limit guard (structural proof)", async () => {
    // This test proves Instagram has a defensive rate limit to prevent --fresh abuse.
    // Pre-migration, --fresh bypassed freshness checks. Post-migration, the adapter
    // enforces a hard 60s minimum between live Instagram API calls regardless of caller.
    //
    // Strategy: Read the adapter source, assert MIN_FETCH_INTERVAL_MS exists and is used in fetch logic.

    const fs = await import("node:fs/promises");
    const adapterSource = await fs.readFile(
      new URL("../../daemons/instagram.ts", import.meta.url),
      "utf-8",
    );

    // Assert: MIN_FETCH_INTERVAL_MS constant exists
    expect(adapterSource).toContain("MIN_FETCH_INTERVAL_MS");

    // Assert: MIN_FETCH_INTERVAL_MS is set to 60_000 (60s hard floor)
    expect(adapterSource).toContain("MIN_FETCH_INTERVAL_MS = 60_000");

    // Assert: fetch() or actuallyFetch() checks sinceLast against MIN_FETCH_INTERVAL_MS
    expect(adapterSource).toMatch(/sinceLast < \w+\.MIN_FETCH_INTERVAL_MS/);

    // Assert: actuallyFetch exists (DRY helper for rate-limited fetch)
    expect(adapterSource).toContain("async actuallyFetch");

    // Assert: lastFetchAt is updated after rate limit check
    expect(adapterSource).toContain("this.lastFetchAt = now");
  });
});
