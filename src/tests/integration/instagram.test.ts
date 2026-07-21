/**
 * Unit tests for Instagram direction detection and read() --fresh path.
 *
 * Instagram uses isOutgoing from the instagram-cli JSON output to determine
 * message direction via readMessageToFull(). The fresh path in read() calls
 * fetchThreadMessages() to backfill uncached sub-messages before returning
 * from cache.
 *
 * Tests here cover:
 * 1. isOutgoing → direction mapping via the production readMessageToFull
 * 2. The --fresh branch calls fetchThreadMessages and upserts results
 * 3. Edge cases (media-only, no text)
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstagramAdapter } from "../../daemons/instagram.ts";
import {
  backfillInstagramThreadMetadata,
  fetchInstagramInbox,
  getInstagramInboxSnapshot,
  type InstagramInventoryThread,
  type ReadMessage,
  readMessageToFull,
} from "../../providers/instagram.ts";
import {
  getCursor,
  getThreadMessages,
  getThreadMetadata,
  recordFetch,
  setCursor,
  upsertMessages,
  upsertThreadMetadata,
} from "../../store.ts";
import {
  type InstagramThreadMetadata,
  isHumanSafeIdentity,
  markDuplicateThreadIdentitiesUnresolved,
  normalizeInstagramThread,
} from "../../thread-identity.ts";
import type { MessageFull, ThreadMetadata } from "../../types.ts";

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

async function withFakeInstagramInbox<T>(data: unknown, operation: () => Promise<T>): Promise<T> {
  const fixtureDir = mkdtempSync(join(tmpdir(), "onemessage-instagram-legacy-inbox-"));
  const fakeCli = join(fixtureDir, "instagram-cli");
  writeFileSync(
    fakeCli,
    `#!/bin/sh
printf '%s\\n' '${JSON.stringify({ ok: true, data })}'
`,
    "utf-8",
  );
  chmodSync(fakeCli, 0o755);
  const originalCli = process.env.ONEMESSAGE_INSTAGRAM_CLI;
  process.env.ONEMESSAGE_INSTAGRAM_CLI = fakeCli;
  try {
    return await operation();
  } finally {
    if (originalCli === undefined) delete process.env.ONEMESSAGE_INSTAGRAM_CLI;
    else process.env.ONEMESSAGE_INSTAGRAM_CLI = originalCli;
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function makeThreadMetadata(threadId: string, displayName: string): InstagramThreadMetadata {
  return {
    provider: "instagram",
    account: "owner",
    threadId,
    title: displayName,
    displayName,
    isGroup: false,
    participantHandles: [displayName],
    lastActivity: NOW,
    updatedAt: NOW,
    resolved: true,
    defaultSenderLabel: `@${displayName}`,
  };
}

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
    const full = readMessageToFull(msg, makeThreadMetadata("thread-abc", "alice"));
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
    const full = readMessageToFull(msg, makeThreadMetadata("thread-abc", "alice"));
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
    const full = readMessageToFull(msg, makeThreadMetadata("thread-xyz", "bob"));
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
    const full = readMessageToFull(msg, makeThreadMetadata("thread-xyz", "bob"));
    expect(full.from?.address).toBe("me");
    expect(full.to[0]?.address).toBe("internal-thread:instagram:owner:thread-xyz");
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
    const full = readMessageToFull(msg, makeThreadMetadata("thread-media", "carol"));
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
    const full = readMessageToFull(msg, makeThreadMetadata("thread-link", "dave"));
    expect(full.body).toBe("[link]");
    expect(full.direction).toBe("in");
  });
});

describe("Instagram thread identity normalization", () => {
  test("prefers a valid provider title", () => {
    const thread = normalizeInstagramThread(
      { id: "thread-1", title: "Alice Example", users: ["alice"], lastActivity: NOW },
      "owner",
    );
    expect(thread).toMatchObject({ displayName: "Alice Example", isGroup: false, resolved: true });
  });

  test("falls back to a consistently formatted one-to-one handle", () => {
    const thread = normalizeInstagramThread(
      { id: "thread-2", title: "User_12345", users: ["alice.example"], lastActivity: NOW },
      "owner",
    );
    expect(thread.displayName).toBe("@alice.example");
  });

  test("does not reinterpret a human title as an Instagram handle", () => {
    const normalized = normalizeInstagramThread(
      {
        id: "thread-title",
        title: "Sophie von Matérn",
        users: ["sophievonmatern"],
        lastActivity: NOW,
      },
      "owner",
    );
    const thread: InstagramThreadMetadata = {
      ...normalized,
      updatedAt: NOW,
      defaultSenderLabel: "@sophievonmatern",
    };
    const message = readMessageToFull(
      {
        id: "cached-title",
        itemType: "text",
        text: "hello",
        userId: "123",
        username: "Sophie von Matérn",
        timestamp: NOW,
        isOutgoing: false,
      },
      thread,
    );
    expect(message.from?.name).toBe("@sophievonmatern");
  });

  test("rejects User, numeric, and raw thread identities", () => {
    expect(isHumanSafeIdentity("User_12345")).toBe(false);
    expect(isHumanSafeIdentity("12345")).toBe(false);
    expect(isHumanSafeIdentity("thread-3", "thread-3")).toBe(false);
    const unresolved = normalizeInstagramThread(
      {
        id: "340282366841710301",
        title: "340282366841710301",
        users: ["User_12345"],
        lastActivity: NOW,
      },
      "owner",
    );
    expect(unresolved).toMatchObject({ displayName: null, resolved: false });
  });

  test("groups require a title and use per-message safe sender labels", () => {
    const normalized = normalizeInstagramThread(
      { id: "group-1", title: "Dance Friends", users: ["alice", "bob"], lastActivity: NOW },
      "owner",
    );
    const thread: InstagramThreadMetadata = {
      ...normalized,
      updatedAt: NOW,
      defaultSenderLabel: "Instagram Participant",
    };
    const incoming = readMessageToFull(
      {
        id: "message-1",
        itemType: "text",
        text: "hello",
        userId: "1",
        username: "alice",
        timestamp: NOW,
        isOutgoing: false,
      },
      thread,
    );
    const unsafe = readMessageToFull(
      {
        id: "message-2",
        itemType: "text",
        text: "hello",
        userId: "2",
        username: "User_12345",
        timestamp: NOW,
        isOutgoing: false,
      },
      thread,
    );
    expect(thread.displayName).toBe("Dance Friends");
    expect(incoming.from?.name).toBe("@alice");
    expect(unsafe.from?.name).toBe("Instagram Participant");
  });

  test("duplicate display identities are unresolved instead of merged", () => {
    const base = (threadId: string): InstagramThreadMetadata => ({
      provider: "instagram",
      account: "owner",
      threadId,
      title: "Same Name",
      displayName: "Same Name",
      isGroup: false,
      participantHandles: [`handle-${threadId}`],
      lastActivity: NOW,
      updatedAt: NOW,
      resolved: true,
      defaultSenderLabel: `@handle-${threadId}`,
    });
    expect(
      markDuplicateThreadIdentitiesUnresolved([base("a"), base("b")]).every(
        (thread) => !thread.resolved,
      ),
    ).toBe(true);
  });

  test("backfill from cached envelopes is idempotent", () => {
    const account = "backfill-account";
    const id = `backfill-${Date.now()}`;
    upsertMessages([
      {
        id,
        provider: "instagram",
        from: { name: "Cached Person", address: "cached_person" },
        to: [{ name: "me", address: "me" }],
        preview: "cached",
        date: NOW,
        unread: false,
        hasAttachments: false,
      },
    ]);
    backfillInstagramThreadMetadata(account);
    const first = getThreadMetadata("instagram", account, id);
    backfillInstagramThreadMetadata(account);
    const second = getThreadMetadata("instagram", account, id);
    expect(second).toEqual(first);
    expect(second?.displayName).toBe("Cached Person");
  });
});

describe("Instagram cached inventory contract", () => {
  function seedThread(account: string): void {
    upsertThreadMetadata({
      provider: "instagram",
      account,
      threadId: "cached-thread",
      title: "Cached Person",
      displayName: "Cached Person",
      isGroup: false,
      participantHandles: ["cached_person"],
      lastActivity: NOW,
    });
  }

  async function inventoryForReason(reason: "fresh-cache" | "cooldown" | "budget-exhausted") {
    const account = `inventory-${reason}`;
    seedThread(account);
    let sourceCalls = 0;
    const adapter = new InstagramAdapter({
      fetchInbox: async () => {
        sourceCalls++;
        return { threads: [], pagesFetched: 1 };
      },
    });
    if (reason === "fresh-cache") recordFetch("instagram", account);
    if (reason === "cooldown") {
      setCursor(
        "instagram",
        account,
        "cooldown_until",
        new Date(Date.now() + 60_000).toISOString(),
      );
    }
    if (reason === "budget-exhausted") {
      setCursor("instagram", account, "request_budget_window_started_at", new Date().toISOString());
      setCursor("instagram", account, "request_budget_count", "10");
    }
    const response = await adapter.handleIpc({ type: "instagram-inventory", account });
    return { response, sourceCalls };
  }

  for (const reason of ["fresh-cache", "cooldown", "budget-exhausted"] as const) {
    test(`returns cached metadata on ${reason} without source calls`, async () => {
      const { response, sourceCalls } = await inventoryForReason(reason);
      expect(response?.ok).toBe(true);
      const data = response?.ok
        ? (response.data as { reason: string; threads: ThreadMetadata[] })
        : null;
      expect(data?.reason).toBe(reason);
      expect(data?.threads.map((thread) => thread.threadId)).toEqual(["cached-thread"]);
      expect(sourceCalls).toBe(0);
    });
  }

  test("cacheOnly IPC returns cached metadata without a source call", async () => {
    const account = "inventory-cache-only";
    seedThread(account);
    let sourceCalls = 0;
    const adapter = new InstagramAdapter({
      fetchInbox: async () => {
        sourceCalls++;
        return { threads: [], pagesFetched: 1 };
      },
    });

    const response = await adapter.handleIpc({
      type: "instagram-inventory",
      account,
      cacheOnly: true,
    });
    const data = response?.ok
      ? (response.data as { performed: boolean; reason: string; threads: ThreadMetadata[] })
      : null;
    expect(data?.performed).toBe(false);
    expect(data?.reason).toBe("cache-only");
    expect(data?.threads.map((thread) => thread.threadId)).toEqual(["cached-thread"]);
    expect(sourceCalls).toBe(0);
  });

  test("fetch-thread IPC preserves budget-exhausted metadata without a source call", async () => {
    const account = "fetch-thread-budget";
    let sourceCalls = 0;
    setCursor("instagram", account, "request_budget_window_started_at", new Date().toISOString());
    setCursor("instagram", account, "request_budget_count", "10");
    const adapter = new InstagramAdapter({
      fetchInbox: async () => ({ threads: [], pagesFetched: 1 }),
      fetchThread: async () => {
        sourceCalls++;
        return [];
      },
    });

    const response = await adapter.handleIpc({
      type: "fetch-thread",
      account,
      threadId: "cached-thread",
    });
    const data = response?.ok ? (response.data as { performed: boolean; reason: string }) : null;
    expect(data).toEqual({ performed: false, reason: "budget-exhausted" });
    expect(sourceCalls).toBe(0);
  });

  test("thread delta includes normalized metadata when source fetch is skipped", async () => {
    const account = "delta-metadata";
    seedThread(account);
    setCursor("instagram", account, "cooldown_until", new Date(Date.now() + 60_000).toISOString());
    const adapter = new InstagramAdapter({
      fetchInbox: async () => ({ threads: [], pagesFetched: 1 }),
    });
    const response = await adapter.handleIpc({
      type: "instagram-thread-delta",
      account,
      threadId: "cached-thread",
    });
    const data = response?.ok
      ? (response.data as { performed: boolean; thread: ThreadMetadata })
      : null;
    expect(data?.performed).toBe(false);
    expect(data?.thread.displayName).toBe("Cached Person");
  });

  test("two actual inbox pages consume two request units", async () => {
    const account = `inventory-two-pages-${Date.now()}`;
    const adapter = new InstagramAdapter({
      fetchInbox: async (_username, opts) => {
        expect(opts?.pages).toBe(2);
        return { threads: [], pagesFetched: 2 };
      },
    });

    const response = await adapter.handleIpc({
      type: "instagram-inventory",
      account,
      maxPages: 2,
    });

    expect(response?.ok).toBe(true);
    const data = response?.ok ? (response.data as { pagesFetched: number }) : null;
    expect(data?.pagesFetched).toBe(2);
    expect(getCursor("instagram", account, "request_budget_count")).toBe("2");
  });

  test("an early one-page stop refunds the unused reservation", async () => {
    const account = `inventory-one-of-two-${Date.now()}`;
    const adapter = new InstagramAdapter({
      fetchInbox: async (_username, opts) => {
        expect(opts?.pages).toBe(2);
        return { threads: [], pagesFetched: 1 };
      },
    });

    const response = await adapter.handleIpc({
      type: "instagram-inventory",
      account,
      maxPages: 2,
    });

    expect(response?.ok).toBe(true);
    expect(getCursor("instagram", account, "request_budget_count")).toBe("1");
  });

  test("invalid actual page counts retain the bounded reservation", async () => {
    const account = `inventory-invalid-pages-${Date.now()}`;
    const adapter = new InstagramAdapter({
      fetchInbox: async () => ({ threads: [], pagesFetched: Number.NaN }),
    });

    const response = await adapter.handleIpc({
      type: "instagram-inventory",
      account,
      maxPages: 2,
    });

    expect(response?.ok).toBe(true);
    expect(getCursor("instagram", account, "request_budget_count")).toBe("2");
  });

  test("routine inventory requests one page and failed reservations remain counted", async () => {
    const account = `inventory-failed-default-${Date.now()}`;
    let requestedPages = 0;
    const adapter = new InstagramAdapter({
      fetchInbox: async (_username, opts) => {
        requestedPages = opts?.pages ?? 0;
        throw new Error("fixture failure");
      },
    });

    const response = await adapter.handleIpc({ type: "instagram-inventory", account });

    expect(response?.ok).toBe(false);
    expect(requestedPages).toBe(1);
    expect(getCursor("instagram", account, "request_budget_count")).toBe("1");
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
          makeThreadMetadata(id, "alice"),
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
          makeThreadMetadata(id, "alice"),
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
          makeThreadMetadata(id, "alice"),
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
          makeThreadMetadata(id, "alice"),
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

    const inboxBody = (inboxMatch?.[0] ?? "")
      .replace(/\/\/.*$/gm, "") // strip line comments
      .replace(/\/\*[\s\S]*?\*\//g, ""); // strip block comments

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

    // Assert: inbox() uses provider-specific cache policy
    expect(inboxBody).toContain('freshnessMs: getProviderFreshnessMs("instagram")');

    // Assert: inbox() passes account:settings.username to helper
    expect(inboxBody).toContain("account: settings.username");
  });

  test("inbox batches full thread messages and persists cache-only snapshot coverage", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "onemessage-instagram-inbox-"));
    const fakeCli = join(fixtureDir, "instagram-cli");
    const requestLog = join(fixtureDir, "requests.txt");
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const account = `snapshot-account-${suffix}`;
    const threadId = `snapshot-thread-${suffix}`;
    const incomingId = `snapshot-in-${suffix}`;
    const outgoingId = `snapshot-out-${suffix}`;
    const payload = {
      ok: true,
      data: {
        threads: [
          {
            id: threadId,
            title: "Snapshot Person",
            users: ["snapshot_person"],
            lastMessage: {
              id: outgoingId,
              itemType: "text",
              text: "outgoing body",
              timestamp: "2026-07-21T10:01:00.000Z",
            },
            lastActivity: "2026-07-21T10:01:00.000Z",
            unread: false,
            recentMessages: [
              {
                id: incomingId,
                itemType: "text",
                text: "incoming body",
                userId: "fixture-user",
                username: "snapshot_person",
                timestamp: "2026-07-21T10:00:00.000Z",
                isOutgoing: false,
              },
              {
                id: outgoingId,
                itemType: "text",
                text: "outgoing body",
                userId: "fixture-self",
                username: account,
                timestamp: "2026-07-21T10:01:00.000Z",
                isOutgoing: true,
              },
            ],
            hasOlderMessages: true,
            oldestCursor: "fixture-oldest-cursor",
          },
        ],
        hasMore: true,
        pagesFetched: 2,
      },
    };
    writeFileSync(
      fakeCli,
      `#!/bin/sh
printf '%s\\n' "$@" > '${requestLog}'
printf '%s\\n' '${JSON.stringify(payload)}'
`,
      "utf-8",
    );
    chmodSync(fakeCli, 0o755);
    const originalCli = process.env.ONEMESSAGE_INSTAGRAM_CLI;
    process.env.ONEMESSAGE_INSTAGRAM_CLI = fakeCli;

    try {
      const fetched = await fetchInstagramInbox(account, { pages: 2 });
      expect(fetched.pagesFetched).toBe(2);
      expect(fetched.threads.map((thread) => thread.id)).toEqual([threadId]);

      const messages = getThreadMessages("instagram", threadId);
      expect(messages.map((message) => message.id)).toEqual([incomingId, outgoingId]);
      expect(messages.map((message) => message.body)).toEqual(["incoming body", "outgoing body"]);
      expect(messages.map((message) => message.direction)).toEqual(["in", "out"]);
      expect(messages.every((message) => message.account === account)).toBe(true);

      const snapshot = getInstagramInboxSnapshot(account, threadId);
      expect(snapshot).toMatchObject({
        messageIds: [incomingId, outgoingId],
        hasOlderMessages: true,
        oldestCursor: "fixture-oldest-cursor",
      });
      expect(Number.isFinite(new Date(snapshot?.fetchedAt ?? "").getTime())).toBe(true);

      let sourceCalls = 0;
      const restartedAdapter = new InstagramAdapter({
        fetchInbox: async () => {
          sourceCalls++;
          return { threads: [], pagesFetched: 1 };
        },
      });
      const response = await restartedAdapter.handleIpc({
        type: "instagram-inventory",
        account,
        cacheOnly: true,
      });
      const inventoryData = response?.ok
        ? (response.data as { threads: InstagramInventoryThread[] })
        : null;
      const inventory = inventoryData?.threads ?? [];
      expect(inventory).toHaveLength(1);
      expect(inventory[0]).toMatchObject({
        threadId,
        recentMessageIds: [incomingId, outgoingId],
        hasOlderMessages: true,
        oldestCursor: "fixture-oldest-cursor",
      });
      expect(inventory[0]?.snapshotFetchedAt).toBe(snapshot?.fetchedAt);
      expect(sourceCalls).toBe(0);

      const sourceRequests = readFileSync(requestLog, "utf-8").split("\n").filter(Boolean);
      expect(sourceRequests[0]).toBe("inbox");
      expect(sourceRequests).not.toContain("read");
    } finally {
      if (originalCli === undefined) delete process.env.ONEMESSAGE_INSTAGRAM_CLI;
      else process.env.ONEMESSAGE_INSTAGRAM_CLI = originalCli;
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("accepts a legacy top-level thread array without claiming snapshot coverage", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const account = `legacy-array-account-${suffix}`;
    const threadId = `legacy-array-thread-${suffix}`;
    const legacyThreads = [
      {
        id: threadId,
        title: "Legacy Array Person",
        users: ["legacy_array_person"],
        lastActivity: "2026-07-21T11:00:00.000Z",
        unread: false,
      },
    ];

    const result = await withFakeInstagramInbox(legacyThreads, () =>
      fetchInstagramInbox(account, { pages: 3 }),
    );

    expect(result.pagesFetched).toBe(3);
    expect(result.threads.map((thread) => thread.id)).toEqual([threadId]);
    expect(getInstagramInboxSnapshot(account, threadId)).toBeNull();
    expect(getThreadMessages("instagram", threadId)).toEqual([]);
  });

  test("legacy object output conservatively charges the requested page cap", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const account = `legacy-object-account-${suffix}`;
    const threadId = `legacy-object-thread-${suffix}`;
    const legacyResult = {
      threads: [
        {
          id: threadId,
          title: "Legacy Object Person",
          users: ["legacy_object_person"],
          lastActivity: "2026-07-21T11:01:00.000Z",
          unread: false,
        },
      ],
      hasMore: false,
    };

    await withFakeInstagramInbox(legacyResult, async () => {
      const adapter = new InstagramAdapter();
      const response = await adapter.handleIpc({
        type: "instagram-inventory",
        account,
        maxPages: 2,
      });
      const data = response?.ok ? (response.data as { pagesFetched: number }) : null;
      expect(data?.pagesFetched).toBe(2);
    });

    expect(getCursor("instagram", account, "request_budget_count")).toBe("2");
    expect(getInstagramInboxSnapshot(account, threadId)).toBeNull();
  });

  test("rejects a present invalid pagesFetched value", async () => {
    await expect(
      withFakeInstagramInbox({ threads: [], hasMore: false, pagesFetched: 0 }, () =>
        fetchInstagramInbox(`invalid-pages-account-${Date.now()}`),
      ),
    ).rejects.toThrow("instagram-cli inbox error");
  });

  test("InstagramAdapter has MIN_FETCH_INTERVAL_MS rate limit guard (structural proof)", async () => {
    // This test proves Instagram has a defensive rate limit to prevent --fresh abuse.
    // Pre-migration, --fresh bypassed freshness checks. Post-migration, the adapter
    // enforces the shared Instagram minimum between live Instagram API calls regardless of caller.
    //
    // Strategy: Read the adapter source, assert MIN_FETCH_INTERVAL_MS exists and is used in fetch logic.

    const fs = await import("node:fs/promises");
    const adapterSource = await fs.readFile(
      new URL("../../daemons/instagram.ts", import.meta.url),
      "utf-8",
    );

    // Assert: MIN_FETCH_INTERVAL_MS constant exists
    expect(adapterSource).toContain("MIN_FETCH_INTERVAL_MS");

    // Assert: MIN_FETCH_INTERVAL_MS uses the shared Instagram cache safety floor.
    expect(adapterSource).toContain('getMinimumProviderFreshnessMs("instagram")');

    // Assert: fetch() or actuallyFetch() checks sinceLast against MIN_FETCH_INTERVAL_MS
    expect(adapterSource).toMatch(/sinceLast < \w+\.MIN_FETCH_INTERVAL_MS/);

    // Assert: actuallyFetch exists (DRY helper for rate-limited fetch)
    expect(adapterSource).toContain("async actuallyFetch");

    // Assert: lastFetchAt is updated before live attempt so failures do not retry every poll tick.
    expect(adapterSource).toContain("this.lastFetchAt = now; // record BEFORE live attempt");
  });

  test("InstagramAdapter daemon polling is explicit opt-in", async () => {
    const fs = await import("node:fs/promises");
    const adapterSource = await fs.readFile(
      new URL("../../daemons/instagram.ts", import.meta.url),
      "utf-8",
    );

    expect(adapterSource).toContain("config.daemon?.providers?.instagram?.enabled === true");
    expect(adapterSource).not.toContain("config.daemon?.providers?.instagram?.enabled !== false");
  });

  test("InstagramAdapter persists cooldown state for auth and rate failures", async () => {
    const fs = await import("node:fs/promises");
    const adapterSource = await fs.readFile(
      new URL("../../daemons/instagram.ts", import.meta.url),
      "utf-8",
    );

    expect(adapterSource).toContain('store.setCursor("instagram", username, "last_attempt_at"');
    expect(adapterSource).toContain('store.setCursor("instagram", username, "last_error_class"');
    expect(adapterSource).toContain('store.setCursor("instagram", username, "cooldown_until"');
    expect(adapterSource).toContain('message.includes("login_required")');
    expect(adapterSource).toContain('message.includes("checkpoint")');
    expect(adapterSource).toContain('message.includes("rate")');
    expect(adapterSource).toContain('message.includes("403")');
  });

  test("Instagram thread refresh failures throw instead of becoming empty threads", async () => {
    const fs = await import("node:fs/promises");
    const instagramSource = await fs.readFile(
      new URL("../../providers/instagram.ts", import.meta.url),
      "utf-8",
    );
    const fetchThreadMatch = instagramSource.match(
      /export async function fetchThreadMessagesPage[\s\S]*?^}/m,
    );
    expect(fetchThreadMatch).not.toBeNull();
    const fetchThreadBody = fetchThreadMatch?.[0] ?? "";

    expect(fetchThreadBody).toContain("throw new Error");
    expect(fetchThreadBody).toContain("instagram-cli read failed");
    expect(fetchThreadBody).toContain("instagram-cli read error");
    expect(fetchThreadBody).not.toContain("return []");
  });

  test("InstagramAdapter records thread refresh attempts before live calls", async () => {
    const fs = await import("node:fs/promises");
    const adapterSource = await fs.readFile(
      new URL("../../daemons/instagram.ts", import.meta.url),
      "utf-8",
    );

    const threadMatch = adapterSource.match(
      /private async actuallyFetchThreadSerialized[\s\S]*?^ {2}}/m,
    );
    expect(threadMatch).not.toBeNull();
    const threadBody = threadMatch?.[0] ?? "";

    expect(threadBody).toContain("this.lastThreadFetchAt.set(threadId, now)");
    expect(threadBody).toContain('store.setCursor("instagram", username, "last_attempt_at"');
    expect(threadBody).toContain("classifyInstagramError(err)");
    expect(threadBody).toContain('store.setCursor("instagram", username, "cooldown_until"');
  });

  test("read() --fresh routes through daemon IPC (structural proof of rate-limit fix)", async () => {
    // This test proves that read() --fresh no longer bypasses MIN_FETCH_INTERVAL_MS.
    // Pre-fix, read(messageId, {fresh:true}) called fetchThreadMessages() directly.
    // Post-fix, it routes via daemon IPC to enforce the rate limit.
    //
    // Strategy: Read the read() source, assert it calls daemonRequest with type:"fetch-thread"

    const fs = await import("node:fs/promises");
    const instagramSource = await fs.readFile(
      new URL("../../providers/instagram.ts", import.meta.url),
      "utf-8",
    );

    // Extract the read() method body
    const readMatch = instagramSource.match(/async read\(messageId, opts\)\s*{[\s\S]*?^ {2}},/m);
    expect(readMatch).not.toBeNull();

    const readBody = (readMatch?.[0] ?? "")
      .replace(/\/\/.*$/gm, "") // strip line comments
      .replace(/\/\*[\s\S]*?\*\//g, ""); // strip block comments

    // Assert: read() body does NOT contain direct fetchThreadMessages call
    expect(readBody).not.toContain("fetchThreadMessages(messageId");

    // Assert: read() calls ensureDaemon
    expect(readBody).toContain("ensureDaemon");

    // Assert: read() calls daemonRequest
    expect(readBody).toContain("daemonRequest");

    // Assert: read() passes type:"fetch-thread" to daemon
    expect(readBody).toContain('type: "fetch-thread"');

    // Assert: read() passes threadId:messageId
    expect(readBody).toContain("threadId: messageId");
  });

  test("InstagramAdapter implements IpcCapableAdapter (structural proof)", async () => {
    // This test proves that InstagramAdapter can handle IPC requests.
    // The adapter now implements handleIpc() to process fetch-thread requests.

    const fs = await import("node:fs/promises");
    const adapterSource = await fs.readFile(
      new URL("../../daemons/instagram.ts", import.meta.url),
      "utf-8",
    );

    // Assert: implements IpcCapableAdapter
    expect(adapterSource).toContain("implements IpcCapableAdapter");

    // Assert: ipcTypes() returns the legacy fetch-thread endpoint and the delta sync endpoints
    expect(adapterSource).toContain('"fetch-thread"');
    expect(adapterSource).toContain('"instagram-inventory"');
    expect(adapterSource).toContain('"instagram-thread-delta"');

    // Assert: handleIpc exists
    expect(adapterSource).toContain("async handleIpc");

    // Assert: actuallyFetchThread helper exists
    expect(adapterSource).toContain("async actuallyFetchThread");

    // Assert: actuallyFetchThread uses MIN_FETCH_INTERVAL_MS guard
    expect(adapterSource).toMatch(
      /actuallyFetchThread[\s\S]*?sinceLast < \w+\.MIN_FETCH_INTERVAL_MS/,
    );
  });
});
