import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// inbox() migration — inboxViaDaemon integration
// ---------------------------------------------------------------------------

describe("matrixProvider.inbox via inboxViaDaemon", () => {
  // NOTE: This migration uses a structural test (source code regex) as the
  // revert guard instead of a behavioral test. Behavioral testing for this
  // migration is environment-dependent (requires Matrix config) and would
  // pass on both pre-migration and post-migration code when cache is fresh.
  // The helper itself (inboxViaDaemon) has behavioral unit tests in
  // shared.test.ts. This structural test proves the provider delegates to
  // that helper, which is a stronger migration guarantee than a flaky
  // behavioral test that could pass on revert.

  test("inbox() calls inboxViaDaemon (structural proof of migration)", async () => {
    // This test proves the migration happened by inspecting the source code structure.
    // The old implementation called freshness checks and fetch directly.
    // The new implementation calls `inboxViaDaemon` (helper that manages daemon lifecycle).
    //
    // Strategy: Read the inbox() source, assert it contains "inboxViaDaemon" and NOT the old direct calls.

    const fs = await import("node:fs/promises");
    const matrixSource = await fs.readFile(
      new URL("../../providers/matrix.ts", import.meta.url),
      "utf-8",
    );

    // Extract the inbox() method body
    const inboxMatch = matrixSource.match(/async inbox\(opts\)\s*{[\s\S]*?^ {2}},/m);
    expect(inboxMatch).not.toBeNull();

    const inboxBody = inboxMatch?.[0] ?? "";

    // Assert: inbox() calls inboxViaDaemon
    expect(inboxBody).toContain("inboxViaDaemon");

    // Assert: inbox() does NOT call store.isFresh directly inside inbox()
    expect(inboxBody).not.toContain("store.isFresh");

    // Assert: inbox() does NOT call store.getCachedInbox directly (helper manages this)
    expect(inboxBody).not.toContain("store.getCachedInbox");

    // Assert: inbox() does NOT call fetchMatrixMessages directly inside inbox()
    expect(inboxBody).not.toContain("fetchMatrixMessages(");

    // Assert: inbox() passes provider:"matrix" to helper
    expect(inboxBody).toContain('provider: "matrix"');

    // Assert: inbox() passes freshnessMs:30_000 to helper
    expect(inboxBody).toContain("freshnessMs: 30_000");

    // Assert: inbox() passes account:settings.userId to helper
    expect(inboxBody).toContain("account: settings.userId");
  });
});
