import { describe, expect, test } from "bun:test";
import { type GroupCacheEntry, resolveGroup } from "../../daemons/whatsapp.ts";

function makeCache(
  entries: Array<{
    id: string;
    subject: string;
    isCommunity?: boolean;
    linkedParent?: string;
  }>,
): Map<string, GroupCacheEntry> {
  const m = new Map<string, GroupCacheEntry>();
  for (const e of entries) m.set(e.id, e);
  return m;
}

// ---------------------------------------------------------------------------
// Simple matching
// ---------------------------------------------------------------------------

describe("resolveGroup — simple matching", () => {
  const cache = makeCache([
    { id: "g1@g.us", subject: "Engineering" },
    { id: "g2@g.us", subject: "Design Team" },
    { id: "g3@g.us", subject: "Marketing" },
  ]);

  test("exact match returns the group", () => {
    const res = resolveGroup("Engineering", cache);
    expect(res.ok).toBe(true);
    expect((res as { ok: true; data: GroupCacheEntry }).data.id).toBe("g1@g.us");
  });

  test("substring match returns the group", () => {
    const res = resolveGroup("Design", cache);
    expect(res.ok).toBe(true);
    expect((res as { ok: true; data: GroupCacheEntry }).data.id).toBe("g2@g.us");
  });

  test("case-insensitive match", () => {
    const res = resolveGroup("marketing", cache);
    expect(res.ok).toBe(true);
    expect((res as { ok: true; data: GroupCacheEntry }).data.id).toBe("g3@g.us");
  });

  test("no match returns error with group name", () => {
    const res = resolveGroup("Nonexistent", cache);
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain("Nonexistent");
  });

  test("multiple non-community matches returns ambiguous error", () => {
    const ambiguousCache = makeCache([
      { id: "g1@g.us", subject: "Team Alpha" },
      { id: "g2@g.us", subject: "Team Beta" },
    ]);
    const res = resolveGroup("Team", ambiguousCache);
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain("ambiguous");
  });
});

// ---------------------------------------------------------------------------
// Community / channel
// ---------------------------------------------------------------------------

describe("resolveGroup — community/channel", () => {
  const cache = makeCache([
    { id: "c1@g.us", subject: "Acme Corp", isCommunity: true },
    {
      id: "ch1@g.us",
      subject: "General",
      linkedParent: "c1@g.us",
    },
    {
      id: "ch2@g.us",
      subject: "Random",
      linkedParent: "c1@g.us",
    },
    { id: "g9@g.us", subject: "Unrelated Group" },
  ]);

  test("community/channel syntax finds channel linked to parent", () => {
    const res = resolveGroup("Acme Corp/General", cache);
    expect(res.ok).toBe(true);
    expect((res as { ok: true; data: GroupCacheEntry }).data.id).toBe("ch1@g.us");
  });

  test("no matching community returns error", () => {
    const res = resolveGroup("Nope Inc/General", cache);
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain("no community");
  });

  test("no matching channel in community returns error listing available channels", () => {
    const res = resolveGroup("Acme Corp/Announcements", cache);
    expect(res.ok).toBe(false);
    const err = (res as { ok: false; error: string }).error;
    expect(err).toContain("Announcements");
    expect(err).toContain("General");
    expect(err).toContain("Random");
  });

  test("ambiguous channels returns error", () => {
    const ambCache = makeCache([
      { id: "c1@g.us", subject: "Acme Corp", isCommunity: true },
      { id: "ch1@g.us", subject: "Dev Alpha", linkedParent: "c1@g.us" },
      { id: "ch2@g.us", subject: "Dev Beta", linkedParent: "c1@g.us" },
    ]);
    const res = resolveGroup("Acme Corp/Dev", ambCache);
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain("ambiguous");
  });

  test("exact community name preferred over substring", () => {
    const multiCache = makeCache([
      { id: "c1@g.us", subject: "Dev", isCommunity: true },
      { id: "c2@g.us", subject: "Dev Team", isCommunity: true },
      { id: "ch1@g.us", subject: "Chat", linkedParent: "c1@g.us" },
      { id: "ch2@g.us", subject: "Chat", linkedParent: "c2@g.us" },
    ]);
    // "Dev/Chat" should prefer exact match community "Dev" over "Dev Team"
    const res = resolveGroup("Dev/Chat", multiCache);
    expect(res.ok).toBe(true);
    expect((res as { ok: true; data: GroupCacheEntry }).data.id).toBe("ch1@g.us");
  });
});

// ---------------------------------------------------------------------------
// Auto-resolution
// ---------------------------------------------------------------------------

describe("resolveGroup — auto-resolution", () => {
  test("single community with default channel (same name) resolves to channel", () => {
    const cache = makeCache([
      { id: "c1@g.us", subject: "My Community", isCommunity: true },
      {
        id: "ch1@g.us",
        subject: "My Community",
        linkedParent: "c1@g.us",
      },
      {
        id: "ch2@g.us",
        subject: "Off-topic",
        linkedParent: "c1@g.us",
      },
    ]);
    const res = resolveGroup("My Community", cache);
    expect(res.ok).toBe(true);
    expect((res as { ok: true; data: GroupCacheEntry }).data.id).toBe("ch1@g.us");
  });

  test("single community without default channel returns helpful error with channel list", () => {
    // Include a child whose subject contains the community name as substring
    // so that multiple results match and the community-auto-resolve path triggers
    const cache = makeCache([
      { id: "c1@g.us", subject: "Builders", isCommunity: true },
      {
        id: "ch1@g.us",
        subject: "Builders Chat",
        linkedParent: "c1@g.us",
      },
      {
        id: "ch2@g.us",
        subject: "Builders Announcements",
        linkedParent: "c1@g.us",
      },
    ]);
    const res = resolveGroup("Builders", cache);
    expect(res.ok).toBe(false);
    const err = (res as { ok: false; error: string }).error;
    expect(err).toContain("community");
    expect(err).toContain("Builders Chat");
    expect(err).toContain("Builders Announcements");
  });

  test("multiple communities prevents auto-resolution and returns ambiguous", () => {
    const cache = makeCache([
      { id: "c1@g.us", subject: "Dev Community", isCommunity: true },
      { id: "c2@g.us", subject: "Dev Ops Community", isCommunity: true },
    ]);
    const res = resolveGroup("Dev", cache);
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain("ambiguous");
  });

  test("community parent in results with unrelated groups doesn't false-positive", () => {
    const cache = makeCache([
      { id: "c1@g.us", subject: "Builders", isCommunity: true },
      { id: "g1@g.us", subject: "Builders Anonymous" },
    ]);
    // Two matches but only one community, and no default channel with same name
    const res = resolveGroup("Builders", cache);
    expect(res.ok).toBe(false);
    const err = (res as { ok: false; error: string }).error;
    // Should mention it's a community and list channels
    expect(err).toContain("community");
  });
});

// ---------------------------------------------------------------------------
// WhatsAppAdapter.fetch() — recordFetch only when connected
// ---------------------------------------------------------------------------

describe("WhatsAppAdapter.fetch()", () => {
  test("recordFetch called only when connected=true (structural proof)", async () => {
    // This test proves that fetch() only calls store.recordFetch when connected.
    // During disconnect/reconnect, the adapter shouldn't mark cache as fresh.
    //
    // Strategy: Read the fetch() source, assert:
    //   1. Exactly one recordFetch call exists
    //   2. That call is inside the if(this.connected) block

    const fs = await import("node:fs/promises");
    const whatsappAdapterSource = await fs.readFile(
      new URL("../../daemons/whatsapp.ts", import.meta.url),
      "utf-8",
    );

    // Extract the fetch() method body
    const fetchMatch = whatsappAdapterSource.match(
      /async fetch\(\): Promise<void>\s*{[\s\S]*?^ {2}}/m,
    );
    expect(fetchMatch).not.toBeNull();

    const fetchBody = (fetchMatch?.[0] ?? "")
      .replace(/\/\/.*$/gm, "") // strip line comments
      .replace(/\/\*[\s\S]*?\*\//g, ""); // strip block comments

    // Assert: exactly one recordFetch call in fetch()
    const occurrences = (fetchBody.match(/recordFetch\(/g) || []).length;
    expect(occurrences).toBe(1);

    // Assert: the if-guard exists and comes before recordFetch
    const ifIdx = fetchBody.indexOf("if (this.connected)");
    const recordIdx = fetchBody.indexOf("recordFetch(");
    expect(ifIdx).toBeGreaterThanOrEqual(0);
    expect(recordIdx).toBeGreaterThan(ifIdx);

    // Assert: recordFetch is structurally INSIDE the if-block (not just textually after)
    // Normalize whitespace and verify the block structure: if (...) { recordFetch }
    expect(fetchBody.replace(/\s+/g, " ")).toMatch(
      /if \(this\.connected\) \{\s*store\.recordFetch\(/,
    );
  });
});
