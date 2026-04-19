import { describe, test, expect } from "bun:test";
import { upsertMessages, getCachedInbox, upsertFullMessages, getCachedMessage } from "./store";

describe("direction field", () => {
  const testProvider = "__test_direction__";

  test("getCachedInbox returns direction from upserted messages", () => {
    const msg = {
      id: "test-dir-in-1",
      provider: testProvider,
      from: { name: "Alice", address: "alice@test.com" },
      to: [{ name: "Bob", address: "bob@test.com" }],
      preview: "hello",
      date: new Date().toISOString(),
      unread: true,
      hasAttachments: false,
    };
    upsertMessages([msg], "in");
    const results = getCachedInbox(testProvider, { limit: 10 });
    const found = results.find(m => m.id === "test-dir-in-1");
    expect(found).toBeDefined();
    expect(found?.direction).toBe("in");
  });

  test("getCachedInbox returns direction='out' for outgoing messages", () => {
    const msg = {
      id: "test-dir-out-1",
      provider: testProvider,
      from: { name: "Bob", address: "bob@test.com" },
      to: [{ name: "Alice", address: "alice@test.com" }],
      preview: "reply",
      date: new Date().toISOString(),
      unread: false,
      hasAttachments: false,
    };
    upsertMessages([msg], "out");
    const results = getCachedInbox(testProvider, { limit: 10 });
    const found = results.find(m => m.id === "test-dir-out-1");
    expect(found).toBeDefined();
    expect(found?.direction).toBe("out");
  });

  test("getCachedMessage returns direction for full messages", () => {
    const msg = {
      id: "test-dir-full-1",
      provider: testProvider,
      from: { name: "Charlie", address: "charlie@test.com" },
      to: [{ name: "Bob", address: "bob@test.com" }],
      preview: "full message",
      body: "full body",
      bodyFormat: "text" as const,
      date: new Date().toISOString(),
      unread: true,
      hasAttachments: false,
      attachments: [],
    };
    upsertFullMessages([msg], "out");
    const result = getCachedMessage(testProvider, "test-dir-full-1");
    expect(result).toBeDefined();
    expect(result?.direction).toBe("out");
  });
});
