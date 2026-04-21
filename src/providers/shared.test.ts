/**
 * Unit + integration tests for shared provider utilities.
 *
 * Tests readFromCacheOrFail and cacheSentMessage against the real store.
 * Uses a unique provider name to avoid collisions with real data.
 */
import { describe, expect, test } from "bun:test";
import * as store from "../store.ts";
import type { MessageFull } from "../types.ts";
import { cacheSentMessage, readFromCacheOrFail } from "./shared.ts";

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
