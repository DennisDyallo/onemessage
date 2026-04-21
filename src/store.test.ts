import { describe, expect, test } from "bun:test";
import {
  backfillMessageNames,
  deleteMessages,
  getCachedInbox,
  getCachedMessage,
  getContactNamesByAddress,
  isFresh,
  recordFetch,
  searchCached,
  upsertContacts,
  upsertFullMessages,
  upsertMessages,
} from "./store";

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
    const found = results.find((m) => m.id === "test-dir-in-1");
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
    const found = results.find((m) => m.id === "test-dir-out-1");
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
      direction: "out" as const,
    };
    upsertFullMessages([msg]);
    const result = getCachedMessage(testProvider, "test-dir-full-1");
    expect(result).toBeDefined();
    expect(result?.direction).toBe("out");
  });
});

// ---------------------------------------------------------------------------
// searchCached
// ---------------------------------------------------------------------------

describe("searchCached", () => {
  const p = "__test_store_search__";

  // Seed data once for the block
  const now = new Date();
  const msgs = [
    {
      id: "s1",
      provider: p,
      from: { name: "Ann", address: "ann@x.com" },
      to: [{ name: "Me", address: "me@x.com" }],
      subject: "Invoice Q1",
      preview: "Please review the invoice",
      body: "Full body of the invoice email",
      bodyFormat: "text" as const,
      date: new Date(now.getTime() - 3600_000).toISOString(),
      unread: false,
      hasAttachments: false,
      attachments: [],
      direction: "in" as const,
    },
    {
      id: "s2",
      provider: p,
      from: { name: "Bob", address: "bob@x.com" },
      to: [{ name: "Me", address: "me@x.com" }],
      subject: "Meeting notes",
      preview: "Here are the meeting notes",
      body: "Detailed meeting notes body",
      bodyFormat: "text" as const,
      date: new Date(now.getTime() - 1800_000).toISOString(),
      unread: true,
      hasAttachments: false,
      attachments: [],
      direction: "in" as const,
    },
    {
      id: "s3",
      provider: "__test_store_search_other__",
      from: { name: "Eve", address: "eve@x.com" },
      to: [{ name: "Me", address: "me@x.com" }],
      subject: "Invoice Q2",
      preview: "Another invoice",
      body: "Another invoice body",
      bodyFormat: "text" as const,
      date: now.toISOString(),
      unread: false,
      hasAttachments: false,
      attachments: [],
      direction: "in" as const,
    },
  ];
  upsertFullMessages(msgs);

  test("finds messages matching body text", () => {
    const results = searchCached("meeting notes");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((m) => m.id === "s2")).toBe(true);
  });

  test("respects provider filter", () => {
    const results = searchCached("invoice", p);
    expect(results.every((m) => m.provider === p)).toBe(true);
    expect(results.some((m) => m.id === "s1")).toBe(true);
    expect(results.some((m) => m.id === "s3")).toBe(false);
  });

  test("respects since date filter", () => {
    const cutoff = new Date(now.getTime() - 2000_000).toISOString();
    const results = searchCached("invoice", undefined, { since: cutoff });
    // s1 is older than cutoff, s3 is newer
    expect(results.some((m) => m.id === "s3")).toBe(true);
    expect(results.some((m) => m.id === "s1")).toBe(false);
  });

  test("respects limit", () => {
    const results = searchCached("invoice", undefined, { limit: 1 });
    expect(results.length).toBe(1);
  });

  test("returns empty array when no matches", () => {
    const results = searchCached("xyznonexistent12345");
    expect(results).toEqual([]);
  });

  test("matches across subject and preview fields", () => {
    // "Invoice" appears in subject, "review" in preview of s1
    const bySubject = searchCached("Invoice Q1", p);
    expect(bySubject.some((m) => m.id === "s1")).toBe(true);
    const byPreview = searchCached("review the invoice", p);
    expect(byPreview.some((m) => m.id === "s1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getCachedInbox filtering
// ---------------------------------------------------------------------------

describe("getCachedInbox filtering", () => {
  const p = "__test_store_inbox__";

  const now = new Date();
  const msgs = [
    {
      id: "i1",
      provider: p,
      from: { name: "Alice Wonder", address: "alice@test.com" },
      to: [{ name: "Me", address: "me@test.com" }],
      preview: "Hello from Alice",
      body: "Hello body",
      bodyFormat: "text" as const,
      date: new Date(now.getTime() - 7200_000).toISOString(),
      unread: true,
      hasAttachments: false,
      attachments: [],
      direction: "in" as const,
    },
    {
      id: "i2",
      provider: p,
      from: { name: "Bob Builder", address: "bob@test.com" },
      to: [{ name: "Me", address: "me@test.com" }],
      preview: "Hello from Bob",
      body: "Bob body",
      bodyFormat: "text" as const,
      date: new Date(now.getTime() - 3600_000).toISOString(),
      unread: false,
      hasAttachments: false,
      attachments: [],
      direction: "in" as const,
    },
    {
      id: "i3",
      provider: p,
      from: { name: "Charlie", address: "charlie@test.com" },
      to: [{ name: "Me", address: "me@test.com" }],
      preview: "Hello from Charlie",
      body: "Charlie body",
      bodyFormat: "text" as const,
      date: now.toISOString(),
      unread: true,
      hasAttachments: false,
      attachments: [],
      direction: "in" as const,
    },
  ];
  upsertFullMessages(msgs);

  // Thread sub-message (should be excluded from inbox)
  upsertFullMessages(
    [
      {
        id: "i-thread-1",
        provider: p,
        from: { name: "Thread Guy", address: "+1234567890" },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "thread sub message",
        body: "thread body",
        bodyFormat: "text" as const,
        date: now.toISOString(),
        unread: true,
        hasAttachments: false,
        attachments: [],
        direction: "in" as const,
      },
    ],
    "+1234567890",
  );

  test("unread filter returns only unread messages", () => {
    const results = getCachedInbox(p, { unread: true, limit: 50 });
    expect(results.every((m) => m.unread)).toBe(true);
    expect(results.some((m) => m.id === "i1")).toBe(true);
    expect(results.some((m) => m.id === "i3")).toBe(true);
    expect(results.some((m) => m.id === "i2")).toBe(false);
  });

  test("since filter returns only messages after date", () => {
    const cutoff = new Date(now.getTime() - 5000_000).toISOString();
    const results = getCachedInbox(p, { since: cutoff, limit: 50 });
    // i2 and i3 are after cutoff, i1 is before
    expect(results.some((m) => m.id === "i2")).toBe(true);
    expect(results.some((m) => m.id === "i3")).toBe(true);
    expect(results.some((m) => m.id === "i1")).toBe(false);
  });

  test("from filter matches by from_name or from_address", () => {
    const byName = getCachedInbox(p, { from: "Alice Wonder", limit: 50 });
    expect(byName.length).toBe(1);
    expect(byName[0]?.id).toBe("i1");

    const byAddr = getCachedInbox(p, { from: "bob@test.com", limit: 50 });
    expect(byAddr.length).toBe(1);
    expect(byAddr[0]?.id).toBe("i2");
  });

  test("limit works correctly", () => {
    const results = getCachedInbox(p, { limit: 2 });
    expect(results.length).toBe(2);
  });

  test("thread sub-messages (thread_id set) excluded from inbox", () => {
    const results = getCachedInbox(p, { limit: 50 });
    expect(results.some((m) => m.id === "i-thread-1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// contacts
// ---------------------------------------------------------------------------

describe("contacts", () => {
  const p = "__test_store_contacts__";
  // Use unique IDs per run to avoid FROM_JSON_MERGE keeping stale names across test runs
  const runId = Date.now().toString(36);

  test("upsertContacts inserts new contacts", () => {
    const addr = `dan-${runId}@test.com`;
    const msgId = `c1-${runId}`;
    upsertContacts(p, [
      { address: addr, name: "Dan" },
      { address: `erin-${runId}@test.com`, name: "Erin" },
    ]);
    // backfill matches when name IS NULL or name == address
    // Use address as name to simulate phone-number-as-name pattern
    upsertFullMessages([
      {
        id: msgId,
        provider: p,
        from: { name: addr, address: addr },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "hi",
        body: "hi",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in" as const,
      },
    ]);
    // backfill should pick up the contact since name == address
    const changed = backfillMessageNames(p);
    expect(changed).toBeGreaterThanOrEqual(1);
    const msg = getCachedMessage(p, msgId);
    expect(msg?.from?.name).toBe("Dan");
  });

  test("upsertContacts updates existing contact name", () => {
    const addr = `dan2-${runId}@test.com`;
    const msgId = `c2-${runId}`;
    upsertContacts(p, [{ address: addr, name: "Daniel" }]);
    // Insert a new message where name == address (triggers backfill)
    upsertFullMessages([
      {
        id: msgId,
        provider: p,
        from: { name: addr, address: addr },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "hey",
        body: "hey",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in" as const,
      },
    ]);
    backfillMessageNames(p);
    const msg = getCachedMessage(p, msgId);
    expect(msg?.from?.name).toBe("Daniel");
  });

  test("getContactNamesByAddress returns address to name map", () => {
    const p2 = "__test_store_contacts_map__";
    upsertFullMessages([
      {
        id: "cm1",
        provider: p2,
        from: { name: "Fay", address: "fay@test.com" },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "hi",
        body: "hi",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in" as const,
      },
    ]);
    const map = getContactNamesByAddress(p2);
    expect(map.get("fay@test.com")).toBe("Fay");
  });

  test("getContactNamesByAddress excludes group addresses (starting with group:)", () => {
    const p3 = "__test_store_contacts_group__";
    upsertFullMessages([
      {
        id: "cg1",
        provider: p3,
        from: { name: "Group Chat", address: "group:123@g.us" },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "group msg",
        body: "group body",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in" as const,
      },
      {
        id: "cg2",
        provider: p3,
        from: { name: "Normal Person", address: "person@test.com" },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "normal msg",
        body: "normal body",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in" as const,
      },
    ]);
    const map = getContactNamesByAddress(p3);
    expect(map.has("group:123@g.us")).toBe(false);
    expect(map.get("person@test.com")).toBe("Normal Person");
  });

  test("backfillMessageNames fills missing from_name from contacts table", () => {
    const p4 = "__test_store_contacts_bf__";
    const bfRunId = Date.now().toString(36);
    const addr = `ghost-${bfRunId}@test.com`;
    const msgId = `bf1-${bfRunId}`;
    upsertContacts(p4, [{ address: addr, name: "Ghost Name" }]);
    upsertFullMessages([
      {
        id: msgId,
        provider: p4,
        from: { name: addr, address: addr },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "boo",
        body: "boo body",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in" as const,
      },
    ]);
    const changed = backfillMessageNames(p4);
    expect(changed).toBe(1);
    const msg = getCachedMessage(p4, msgId);
    expect(msg?.from?.name).toBe("Ghost Name");
  });

  test("backfillMessageNames handles multiple messages needing backfill", () => {
    const p6 = "__test_store_contacts_multi__";
    const multiRunId = Date.now().toString(36);
    const addr1 = `multi1-${multiRunId}@test.com`;
    const addr2 = `multi2-${multiRunId}@test.com`;
    upsertContacts(p6, [
      { address: addr1, name: "First" },
      { address: addr2, name: "Second" },
    ]);
    upsertFullMessages([
      {
        id: `mm1-${multiRunId}`,
        provider: p6,
        from: { name: addr1, address: addr1 },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "a",
        body: "a",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in" as const,
      },
      {
        id: `mm2-${multiRunId}`,
        provider: p6,
        from: { name: addr2, address: addr2 },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "b",
        body: "b",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in" as const,
      },
    ]);
    const changed = backfillMessageNames(p6);
    expect(changed).toBe(2);
  });

  test("backfillMessageNames skips messages that already have a real name", () => {
    const p5 = "__test_store_contacts_skip__";
    upsertContacts(p5, [{ address: "known@test.com", name: "New Name" }]);
    upsertFullMessages([
      {
        id: "bf2",
        provider: p5,
        from: { name: "Original Name", address: "known@test.com" },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "hey",
        body: "hey body",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in" as const,
      },
    ]);
    const changed = backfillMessageNames(p5);
    expect(changed).toBe(0);
    const msg = getCachedMessage(p5, "bf2");
    expect(msg?.from?.name).toBe("Original Name");
  });
});

// ---------------------------------------------------------------------------
// freshness
// ---------------------------------------------------------------------------

describe("freshness", () => {
  const p = "__test_store_fresh__";

  test("isFresh returns false when no fetch recorded", () => {
    expect(isFresh(p, 60_000)).toBe(false);
  });

  test("recordFetch then isFresh returns true within maxAge", () => {
    const p2 = "__test_store_fresh_rec__";
    recordFetch(p2);
    expect(isFresh(p2, 60_000)).toBe(true);
  });

  test("isFresh returns false after maxAge expires", async () => {
    const p3 = "__test_store_fresh_exp__";
    recordFetch(p3);
    await new Promise((r) => setTimeout(r, 5));
    expect(isFresh(p3, 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deleteMessages
// ---------------------------------------------------------------------------

describe("deleteMessages", () => {
  test("removes messages by provider and id array", () => {
    const p = "__test_store_del__";
    upsertFullMessages([
      {
        id: "d1",
        provider: p,
        from: { name: "X", address: "x@test.com" },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "delete me",
        body: "body",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in" as const,
      },
      {
        id: "d2",
        provider: p,
        from: { name: "Y", address: "y@test.com" },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "keep me",
        body: "body",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in" as const,
      },
    ]);
    deleteMessages(p, ["d1"]);
    expect(getCachedMessage(p, "d1")).toBeNull();
    expect(getCachedMessage(p, "d2")).not.toBeNull();
  });
});
