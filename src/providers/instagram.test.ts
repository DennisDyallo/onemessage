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
import type { MessageFull } from "../types.ts";

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
