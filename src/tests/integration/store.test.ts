import { describe, expect, test } from "bun:test";
import {
  backfillMessageNames,
  deleteMessages,
  getCachedInbox,
  getCachedInboxPage,
  getCachedMessage,
  getContactNamesByAddress,
  getDb,
  isFresh,
  recordFetch,
  repairMisattributedOwnerNames,
  searchCached,
  upsertContacts,
  upsertFullMessages,
  upsertMessages,
} from "../../store.ts";

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

describe("owner-name poison resolution & repair", () => {
  const OWNER = "46737124377";
  const OWNER_NAME = "Dennis";

  test("getContactNamesByAddress prefers contacts table over poisoned message name", () => {
    const p = "__test_poison_resolve__";
    upsertContacts(p, [{ address: "46728418689", name: "John (tenant)" }]);
    upsertFullMessages([
      {
        id: "poison-in-1",
        provider: p,
        // Poison: inbound from John but pushName leaked owner's name.
        from: { name: OWNER_NAME, address: "46728418689" },
        to: [{ name: OWNER_NAME, address: OWNER }],
        preview: "x",
        body: "x",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in" as const,
      },
    ]);
    const map = getContactNamesByAddress(p, { ownerAddress: OWNER, ownerName: OWNER_NAME });
    // Contacts table wins, not the poisoned message name.
    expect(map.get("46728418689")).toBe("John (tenant)");
    // Owner's own address is never in the map.
    expect(map.has(OWNER)).toBe(false);
  });

  test("getContactNamesByAddress skips message-derived owner name for unknown address", () => {
    const p = "__test_poison_unknown__";
    upsertFullMessages([
      {
        id: "poison-in-2",
        provider: p,
        from: { name: OWNER_NAME, address: "999000111" }, // not in contacts
        to: [{ name: OWNER_NAME, address: OWNER }],
        preview: "x",
        body: "x",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in" as const,
      },
    ]);
    const map = getContactNamesByAddress(p, { ownerAddress: OWNER, ownerName: OWNER_NAME });
    // Poisoned owner-name for an unknown address is dropped (not propagated).
    expect(map.has("999000111")).toBe(false);
  });

  test("getContactNamesByAddress keeps a real contact who shares the owner's display name", () => {
    const p = "__test_real_namesake__";
    // A genuine contact literally named "Dennis" at their own distinct address.
    upsertContacts(p, [{ address: "46700123456", name: "Dennis" }]);
    const map = getContactNamesByAddress(p, { ownerAddress: OWNER, ownerName: OWNER_NAME });
    expect(map.get("46700123456")).toBe("Dennis");
  });

  test("repairMisattributedOwnerNames fixes outbound to.name and inbound from.name", () => {
    const p = "__test_repair_basic__";
    upsertContacts(p, [{ address: "46728418689", name: "John (tenant)" }]);
    upsertFullMessages([
      {
        id: "rep-out-1",
        provider: p,
        from: { name: OWNER_NAME, address: OWNER },
        to: [{ name: OWNER_NAME, address: "46728418689" }], // poisoned recipient name
        preview: "o",
        body: "o",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "out" as const,
      },
      {
        id: "rep-in-1",
        provider: p,
        from: { name: OWNER, address: "46728418689" }, // poisoned by owner NUMBER
        to: [{ name: OWNER_NAME, address: OWNER }],
        preview: "i",
        body: "i",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in" as const,
      },
    ]);
    const r = repairMisattributedOwnerNames(p, OWNER, OWNER_NAME);
    expect(r.outbound).toBe(1);
    expect(r.inbound).toBe(1);
    expect(getCachedMessage(p, "rep-out-1")?.to?.[0]?.name).toBe("John (tenant)");
    expect(getCachedMessage(p, "rep-in-1")?.from?.name).toBe("John (tenant)");
    // Idempotent: second run changes nothing.
    const r2 = repairMisattributedOwnerNames(p, OWNER, OWNER_NAME);
    expect(r2.outbound).toBe(0);
    expect(r2.inbound).toBe(0);
  });

  test("repairMisattributedOwnerNames leaves self-directed and unknown-address rows untouched", () => {
    const p = "__test_repair_scope__";
    // self-directed (to == owner) and an unknown address not in contacts
    upsertFullMessages([
      {
        id: "rep-self",
        provider: p,
        from: { name: OWNER_NAME, address: OWNER },
        to: [{ name: OWNER_NAME, address: OWNER }], // self note
        preview: "s",
        body: "s",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "out" as const,
      },
      {
        id: "rep-unknown",
        provider: p,
        from: { name: OWNER_NAME, address: OWNER },
        to: [{ name: OWNER_NAME, address: "555000999" }], // not in contacts
        preview: "u",
        body: "u",
        bodyFormat: "text" as const,
        date: new Date().toISOString(),
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "out" as const,
      },
    ]);
    const r = repairMisattributedOwnerNames(p, OWNER, OWNER_NAME);
    expect(r.outbound).toBe(0);
    expect(getCachedMessage(p, "rep-self")?.to?.[0]?.name).toBe(OWNER_NAME);
    expect(getCachedMessage(p, "rep-unknown")?.to?.[0]?.name).toBe(OWNER_NAME);
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

// ---------------------------------------------------------------------------
// sinceCachedAt filter
// ---------------------------------------------------------------------------

describe("sinceCachedAt filter", () => {
  const p = "__test_cached_at__";

  test("filters by cached_at timestamp, not message date", () => {
    const baseDate = "2026-01-01T12:00:00Z";
    const t1 = "2026-05-30T10:00:00Z";
    const t2 = "2026-05-30T11:00:00Z";
    const t3 = "2026-05-30T12:00:00Z";

    // Insert 3 messages with SAME message date but DIFFERENT cached_at
    // We'll manually set cached_at via direct DB manipulation after upsert
    const msgs = [
      {
        id: "cached-1",
        provider: p,
        from: { name: "A", address: "a@test.com" },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "first",
        date: baseDate,
        unread: false,
        hasAttachments: false,
      },
      {
        id: "cached-2",
        provider: p,
        from: { name: "B", address: "b@test.com" },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "second",
        date: baseDate,
        unread: false,
        hasAttachments: false,
      },
      {
        id: "cached-3",
        provider: p,
        from: { name: "C", address: "c@test.com" },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "third",
        date: baseDate,
        unread: false,
        hasAttachments: false,
      },
    ];

    upsertMessages(msgs, "in");

    // Manually update cached_at for testing
    // This simulates history-sync where old messages get new cached_at
    const db = getDb();
    const updateStmt = db.prepare(
      "UPDATE messages SET cached_at = ? WHERE provider = ? AND id = ?",
    );
    updateStmt.run(t1, p, "cached-1");
    updateStmt.run(t2, p, "cached-2");
    updateStmt.run(t3, p, "cached-3");

    // Query with sinceCachedAt between t1 and t3
    const results = getCachedInbox(p, { sinceCachedAt: t2, limit: 10 });

    // Should return only messages cached AFTER t2 (i.e., cached-3)
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("cached-3");
  });

  test("sinceCachedAt composes with since filter", () => {
    const oldDate = "2026-01-01T00:00:00Z";
    const recentDate = "2026-05-30T00:00:00Z";
    const t1 = "2026-05-30T10:00:00Z";
    const t2 = "2026-05-30T11:00:00Z";

    const msgs = [
      {
        id: "compose-1",
        provider: p,
        from: { name: "X", address: "x@test.com" },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "old date, old cached",
        date: oldDate,
        unread: false,
        hasAttachments: false,
      },
      {
        id: "compose-2",
        provider: p,
        from: { name: "Y", address: "y@test.com" },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "recent date, old cached",
        date: recentDate,
        unread: false,
        hasAttachments: false,
      },
      {
        id: "compose-3",
        provider: p,
        from: { name: "Z", address: "z@test.com" },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "recent date, recent cached",
        date: recentDate,
        unread: false,
        hasAttachments: false,
      },
    ];

    upsertMessages(msgs, "in");

    const db = getDb();
    const updateStmt = db.prepare(
      "UPDATE messages SET cached_at = ? WHERE provider = ? AND id = ?",
    );
    updateStmt.run(t1, p, "compose-1");
    updateStmt.run(t1, p, "compose-2");
    updateStmt.run(t2, p, "compose-3");

    // Both filters: since (message date) AND sinceCachedAt
    // Query with sinceCachedAt = t1, so should exclude compose-1 and compose-2 (cached at t1)
    // but include compose-3 (cached at t2, which is > t1)
    const results = getCachedInbox(p, {
      since: recentDate,
      sinceCachedAt: t1,
      limit: 10,
    });

    // Should return only compose-3 (recent date AND cached_at > t1)
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("compose-3");
  });

  test("changefeed mode orders by cached_at then id", () => {
    const provider = "__test_cached_at_order__";
    const t1 = "2026-05-30T10:00:00Z";
    const t2 = "2026-05-30T11:00:00Z";
    const msgs = [
      {
        id: "order-new-date-old-cache",
        provider,
        from: { name: "A", address: "a@test.com" },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "new date old cache",
        date: "2026-06-01T00:00:00Z",
        unread: false,
        hasAttachments: false,
      },
      {
        id: "order-old-date-new-cache",
        provider,
        from: { name: "B", address: "b@test.com" },
        to: [{ name: "Me", address: "me@test.com" }],
        preview: "old date new cache",
        date: "2026-01-01T00:00:00Z",
        unread: false,
        hasAttachments: false,
      },
    ];

    upsertMessages(msgs, "in");
    const db = getDb();
    const updateStmt = db.prepare(
      "UPDATE messages SET cached_at = ? WHERE provider = ? AND id = ?",
    );
    updateStmt.run(t1, provider, "order-new-date-old-cache");
    updateStmt.run(t2, provider, "order-old-date-new-cache");

    const normal = getCachedInbox(provider, { sinceCachedAt: "2026-05-30T09:00:00Z", limit: 10 });
    expect(normal.map((m) => m.id)).toEqual([
      "order-new-date-old-cache",
      "order-old-date-new-cache",
    ]);

    const page = getCachedInboxPage(provider, {
      sinceCachedAt: "2026-05-30T09:00:00Z",
      changefeed: true,
      limit: 10,
    });
    expect(page.messages.map((m) => m.id)).toEqual([
      "order-new-date-old-cache",
      "order-old-date-new-cache",
    ]);
  });

  test("changefeed cursor pages tied cached_at without loss or duplicates", () => {
    const provider = "__test_cached_at_ties__";
    const cachedAt = "2026-05-30T10:00:00Z";
    const msgs = ["tie-1", "tie-2", "tie-3"].map((id) => ({
      id,
      provider,
      from: { name: "A", address: "a@test.com" },
      to: [{ name: "Me", address: "me@test.com" }],
      preview: id,
      date: "2026-01-01T00:00:00Z",
      unread: false,
      hasAttachments: false,
    }));

    upsertMessages(msgs, "in");
    const db = getDb();
    const updateStmt = db.prepare(
      "UPDATE messages SET cached_at = ? WHERE provider = ? AND id = ?",
    );
    for (const id of ["tie-1", "tie-2", "tie-3"]) updateStmt.run(cachedAt, provider, id);

    const page1 = getCachedInboxPage(provider, {
      sinceCachedAt: "2026-05-30T09:00:00Z",
      changefeed: true,
      limit: 2,
    });
    expect(page1.messages.map((m) => m.id)).toEqual(["tie-1", "tie-2"]);
    expect(page1.nextCursor).toBeDefined();
    expect(page1.hasMore).toBe(true);

    const page2 = getCachedInboxPage(provider, {
      cursor: page1.nextCursor,
      changefeed: true,
      limit: 2,
    });
    expect(page2.messages.map((m) => m.id)).toEqual(["tie-3"]);
    expect(page2.nextCursor).toBeDefined();
    expect(page2.hasMore).toBe(false);
  });

  test("changefeed mode applies account filter", () => {
    const provider = "__test_cached_at_account__";
    const cachedAt = "2026-05-30T10:00:00Z";
    upsertMessages(
      [
        {
          id: "account-a",
          provider,
          account: "a@example.com",
          from: { name: "A", address: "a@test.com" },
          to: [{ name: "Me", address: "me@test.com" }],
          preview: "account a",
          date: "2026-01-01T00:00:00Z",
          unread: false,
          hasAttachments: false,
        },
        {
          id: "account-b",
          provider,
          account: "b@example.com",
          from: { name: "B", address: "b@test.com" },
          to: [{ name: "Me", address: "me@test.com" }],
          preview: "account b",
          date: "2026-01-01T00:00:00Z",
          unread: false,
          hasAttachments: false,
        },
      ],
      "in",
    );

    const db = getDb();
    const updateStmt = db.prepare("UPDATE messages SET cached_at = ? WHERE provider = ?");
    updateStmt.run(cachedAt, provider);

    const page = getCachedInboxPage(provider, {
      sinceCachedAt: "2026-05-30T09:00:00Z",
      changefeed: true,
      account: "b@example.com",
      limit: 10,
    });

    expect(page.messages.map((m) => m.id)).toEqual(["account-b"]);
  });

  test("changefeed mode applies excluded account filter", () => {
    const provider = "__test_cached_at_excluded_account__";
    const cachedAt = "2026-05-30T10:00:00Z";
    upsertMessages(
      [
        {
          id: "primary-account",
          provider,
          account: "primary@example.com",
          from: { name: "A", address: "a@test.com" },
          to: [{ name: "Me", address: "me@test.com" }],
          preview: "primary",
          date: "2026-01-01T00:00:00Z",
          unread: false,
          hasAttachments: false,
        },
        {
          id: "secondary-account",
          provider,
          account: "secondary@example.com",
          from: { name: "B", address: "b@test.com" },
          to: [{ name: "Me", address: "me@test.com" }],
          preview: "secondary",
          date: "2026-01-01T00:00:00Z",
          unread: false,
          hasAttachments: false,
        },
      ],
      "in",
    );

    const db = getDb();
    const updateStmt = db.prepare("UPDATE messages SET cached_at = ? WHERE provider = ?");
    updateStmt.run(cachedAt, provider);

    const page = getCachedInboxPage(provider, {
      sinceCachedAt: "2026-05-30T09:00:00Z",
      changefeed: true,
      excludeAccounts: ["secondary@example.com"],
      limit: 10,
    });

    expect(page.messages.map((m) => m.id)).toEqual(["primary-account"]);
  });

  test("re-upserting existing message preserves original cached_at", () => {
    const t0 = "2026-05-30T09:00:00Z";
    const t1 = "2026-05-30T10:00:00Z";

    // Insert message at t0
    const msg = {
      id: "upsert-test-1",
      provider: p,
      from: { name: "Alice", address: "alice@test.com" },
      to: [{ name: "Me", address: "me@test.com" }],
      preview: "original",
      date: "2026-05-30T00:00:00Z",
      unread: true,
      hasAttachments: false,
    };
    upsertMessages([msg], "in");

    // Manually set cached_at to t0
    const db = getDb();
    const updateStmt = db.prepare(
      "UPDATE messages SET cached_at = ? WHERE provider = ? AND id = ?",
    );
    updateStmt.run(t0, p, "upsert-test-1");

    // Verify cached_at is t0
    const beforeUpsert = getCachedInbox(p, { limit: 100 });
    const before = beforeUpsert.find((m) => m.id === "upsert-test-1");
    expect(before?.cachedAt).toBe(t0);

    // Re-upsert the same message (simulates refresh)
    const updated = {
      ...msg,
      preview: "updated preview",
      unread: false,
    };
    upsertMessages([updated], "in");

    // Query with sinceCachedAt cursor between t0 and t2
    // Message should NOT appear because its cached_at should still be t0 (not updated)
    const afterCursor = getCachedInbox(p, { sinceCachedAt: t1, limit: 100 });
    const found = afterCursor.find((m) => m.id === "upsert-test-1");
    expect(found).toBeUndefined();

    // Verify cached_at is STILL t0 (not overwritten by upsert)
    const afterUpsert = getCachedInbox(p, { limit: 100 });
    const after = afterUpsert.find((m) => m.id === "upsert-test-1");
    expect(after?.cachedAt).toBe(t0);
    expect(after?.preview).toBe("updated preview"); // Other fields updated
  });

  test("sinceCachedAt rejects empty string", () => {
    expect(() => getCachedInbox(p, { sinceCachedAt: "" })).toThrow(
      "sinceCachedAt cannot be empty string",
    );
  });

  test("sinceCachedAt rejects malformed timestamp", () => {
    expect(() => getCachedInbox(p, { sinceCachedAt: "not-a-date" })).toThrow(
      "sinceCachedAt must be valid ISO timestamp",
    );
  });

  test("sinceCachedAt rejects ISO-prefixed garbage that JS Date would silently coerce", () => {
    // `new Date("2026-05-30junk")` returns a valid Date for some inputs — strict regex must catch this
    expect(() => getCachedInbox(p, { sinceCachedAt: "2026-05-30junk" })).toThrow(
      "sinceCachedAt must be valid ISO timestamp",
    );
    expect(() => getCachedInbox(p, { sinceCachedAt: "2026-05-30" })).toThrow(
      "sinceCachedAt must be valid ISO timestamp",
    );
  });
});
