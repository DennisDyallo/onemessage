import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// inbox() migration — inboxViaDaemon integration
// ---------------------------------------------------------------------------

describe("telegramBotProvider.inbox via inboxViaDaemon", () => {
  // NOTE: This migration uses a structural test (source code regex) as the
  // revert guard instead of a behavioral test. Behavioral testing for this
  // migration is environment-dependent (requires Telegram bot config) and
  // would pass on both pre-migration and post-migration code when cache is
  // fresh. The helper itself (inboxViaDaemon) has behavioral unit tests in
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
    const telegramBotSource = await fs.readFile(
      new URL("../../providers/telegram-bot.ts", import.meta.url),
      "utf-8",
    );

    // Extract the inbox() method body
    const inboxMatch = telegramBotSource.match(/async inbox\(opts\)\s*{[\s\S]*?^ {2}},/m);
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

    // Assert: inbox() does NOT call fetchTelegramBotUpdates directly inside inbox()
    expect(inboxBody).not.toContain("fetchTelegramBotUpdates");

    // Assert: inbox() passes provider:"telegram-bot" to helper
    expect(inboxBody).toContain('provider: "telegram-bot"');

    // Assert: inbox() uses provider-specific cache policy
    expect(inboxBody).toContain('freshnessMs: getProviderFreshnessMs("telegram-bot")');

    // Assert: inbox() passes account:"bot" to helper
    expect(inboxBody).toContain('account: "bot"');
  });
});
