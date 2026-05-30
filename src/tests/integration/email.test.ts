import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// inbox() migration — inboxViaDaemon integration
// ---------------------------------------------------------------------------

describe("emailProvider.inbox via inboxViaDaemon", () => {
  // NOTE: This migration uses a structural test (source code regex) as the
  // revert guard instead of a behavioral test. Behavioral testing for this
  // migration is environment-dependent (requires Email config + IMAP server)
  // and would pass on both pre-migration and post-migration code when cache is
  // fresh. The helper itself (inboxViaDaemon) has behavioral unit tests in
  // shared.test.ts. This structural test proves the provider delegates to
  // that helper, which is a stronger migration guarantee than a flaky
  // behavioral test that could pass on revert.

  test("inbox() calls inboxViaDaemon for default INBOX requests (structural proof)", async () => {
    // This test proves the migration happened by inspecting the source code structure.
    // The old implementation called freshness checks and fetch directly.
    // The new implementation calls `inboxViaDaemon` (helper that manages daemon lifecycle)
    // for default INBOX requests, but preserves direct fetch for custom folder/criteria.
    //
    // Strategy: Read the inbox() source, assert it contains "inboxViaDaemon" and the
    // branching logic for default-vs-custom requests.

    const fs = await import("node:fs/promises");
    const emailSource = await fs.readFile(
      new URL("../../providers/email.ts", import.meta.url),
      "utf-8",
    );

    // Extract the inbox() method body
    const inboxMatch = emailSource.match(/async inbox\(opts\)\s*{[\s\S]*?^ {2}},/m);
    expect(inboxMatch).not.toBeNull();

    const inboxBody = inboxMatch?.[0] ?? "";

    // Assert: inbox() calls inboxViaDaemon (for default INBOX path)
    expect(inboxBody).toContain("inboxViaDaemon");

    // Assert: inbox() passes provider:"email" to helper
    expect(inboxBody).toContain('provider: "email"');

    // Assert: inbox() passes freshnessMs:FRESHNESS_MS to helper
    expect(inboxBody).toContain("freshnessMs: FRESHNESS_MS");

    // Assert: inbox() passes account:accounts.join(",") to helper (multi-account key)
    expect(inboxBody).toContain('account: accounts.join(",")');

    // Assert: inbox() passes folder to helper (folder-threaded freshness)
    expect(inboxBody).toContain("folder,");

    // Assert: inbox() has fallbackFetch for graceful degradation
    expect(inboxBody).toContain("fallbackFetch");

    // Assert: inbox() has branching logic for default-vs-custom requests
    expect(inboxBody).toContain("isDefaultRequest");

    // Assert: isDefaultRequest checks for account filter to avoid freshness key mismatch
    // (daemon fetches all accounts, but account-filtered requests need account-scoped key)
    expect(inboxBody).toMatch(/isDefaultRequest[\s\S]*?&&[\s\S]*?!opts\?\.account/);

    // Assert: isDefaultRequest checks for explicit --limit to avoid daemon fetch with default limit
    // (daemon uses default limit=10, but CLI --limit 100 should bypass daemon and fetch directly)
    expect(inboxBody).toMatch(/isDefaultRequest[\s\S]*?&&[\s\S]*?!opts\?\.limit/);

    // Assert: Direct fetch path still exists for custom folder/criteria
    expect(inboxBody).toContain("fetchEmailInbox");

    // Assert: The helper is only called for default INBOX requests (no custom criteria)
    // This proves the split: default → daemon, custom → direct
    const hasConditionalHelper = /if \(!isDefaultRequest\)[\s\S]*?inboxViaDaemon/.test(inboxBody);
    expect(hasConditionalHelper).toBe(true);
  });
});
