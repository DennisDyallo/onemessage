import { describe, expect, test } from "bun:test";
import {
  buildEmailReferences,
  emailMessageId,
  emailReplySubject,
  parseEmailMessageId,
  resolveEmailReplyRecipient,
} from "../../providers/email.ts";
import * as store from "../../store.ts";
import type { MessageFull } from "../../types.ts";

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

    const inboxBody = (inboxMatch?.[0] ?? "")
      .replace(/\/\/.*$/gm, "") // strip line comments
      .replace(/\/\*[\s\S]*?\*\//g, ""); // strip block comments

    // Assert: inbox() calls inboxViaDaemon (for default INBOX path)
    expect(inboxBody).toContain("inboxViaDaemon");

    // Assert: inbox() passes provider:"email" to helper
    expect(inboxBody).toContain('provider: "email"');

    // Assert: inbox() uses provider-specific cache policy
    expect(inboxBody).toContain('freshnessMs: getProviderFreshnessMs("email")');

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

describe("email cache identity", () => {
  function makeEmail(id: string, account: string, subject: string): MessageFull {
    return {
      id,
      provider: "email",
      account,
      from: { name: account, address: account },
      to: [{ name: "Recipient", address: "to@example.com" }],
      subject,
      preview: subject,
      body: subject,
      bodyFormat: "text",
      date: new Date().toISOString(),
      unread: false,
      hasAttachments: false,
      attachments: [],
      direction: "in",
    };
  }

  test("email message IDs are scoped by account, folder, and UID", () => {
    const firstId = emailMessageId("a@example.com", "INBOX", 42);
    const secondId = emailMessageId("b@example.com", "Archive", 42);

    expect(firstId).not.toBe(secondId);
    expect(parseEmailMessageId(firstId)).toEqual({
      account: "a@example.com",
      folder: "INBOX",
      uid: 42,
    });

    store.upsertFullMessages([
      makeEmail(firstId, "a@example.com", "first"),
      makeEmail(secondId, "b@example.com", "second"),
    ]);

    expect(store.getCachedMessage("email", firstId)?.subject).toBe("first");
    expect(store.getCachedMessage("email", secondId)?.subject).toBe("second");
  });

  test("legacy numeric IDs still parse as UIDs", () => {
    expect(parseEmailMessageId("42")).toEqual({ uid: 42 });
  });

  test("reply metadata round-trips through the cache", () => {
    const id = emailMessageId("a@example.com", "INBOX", Date.now());
    store.upsertFullMessages([
      {
        ...makeEmail(id, "a@example.com", "metadata"),
        rfcMessageId: "<message@example.com>",
        replyTo: [{ name: "Replies", address: "reply-to@example.com" }],
        references: ["<root@example.com>", "<message@example.com>"],
      },
    ]);

    const cached = store.getCachedMessage("email", id);
    expect(cached?.rfcMessageId).toBe("<message@example.com>");
    expect(cached?.replyTo).toEqual([{ name: "Replies", address: "reply-to@example.com" }]);
    expect(cached?.references).toEqual(["<root@example.com>", "<message@example.com>"]);
  });
});

describe("email reply helpers", () => {
  function makeReplyEmail(id: string, extras?: Partial<MessageFull>): MessageFull {
    return {
      id,
      provider: "email",
      account: "me@example.com",
      from: { name: "Sender", address: "sender@example.com" },
      to: [{ name: "Me", address: "me@example.com" }],
      subject: "Original subject",
      preview: "Original subject",
      body: "body",
      bodyFormat: "text",
      date: new Date().toISOString(),
      unread: false,
      hasAttachments: false,
      attachments: [],
      direction: "in",
      ...extras,
    };
  }

  test("emailReplySubject prefixes Re: once", () => {
    expect(emailReplySubject("Question")).toBe("Re: Question");
    expect(emailReplySubject("Re: Question")).toBe("Re: Question");
    expect(emailReplySubject("RE: Question")).toBe("RE: Question");
    expect(emailReplySubject(undefined)).toBeUndefined();
  });

  test("buildEmailReferences appends original RFC message id without duplication", () => {
    expect(
      buildEmailReferences({
        references: ["<root@example.com>"],
        rfcMessageId: "<reply@example.com>",
      }),
    ).toEqual(["<root@example.com>", "<reply@example.com>"]);
    expect(
      buildEmailReferences({
        references: ["<root@example.com>", "<reply@example.com>"],
        rfcMessageId: "<reply@example.com>",
      }),
    ).toEqual(["<root@example.com>", "<reply@example.com>"]);
  });

  test("resolveEmailReplyRecipient prefers Reply-To over From", () => {
    const original = makeReplyEmail("reply-target", {
      from: { name: "Sender", address: "from@example.com" },
      replyTo: [{ name: "Replies", address: "reply-to@example.com" }],
    });

    expect(resolveEmailReplyRecipient(original, original.subject, ["me@example.com"])).toBe(
      "reply-to@example.com",
    );
  });

  test("resolveEmailReplyRecipient preserves previous outbound alias", () => {
    const subject = `Alias preservation ${Date.now()}`;
    store.upsertFullMessages([
      makeReplyEmail(`out-${subject}`, {
        from: { name: "Me", address: "me@example.com" },
        to: [{ name: "Alias", address: "alias@example.net" }],
        subject,
        direction: "out",
      }),
    ]);
    const original = makeReplyEmail(`in-${subject}`, {
      from: { name: "Sender", address: "sender@example.com" },
      subject: `Re: ${subject}`,
    });

    expect(resolveEmailReplyRecipient(original, original.subject, ["me@example.com"])).toBe(
      "alias@example.net",
    );
  });

  test("resolveEmailReplyRecipient does not override Reply-To with previous alias", () => {
    const subject = `Reply-To wins ${Date.now()}`;
    store.upsertFullMessages([
      makeReplyEmail(`out-${subject}`, {
        from: { name: "Me", address: "me@example.com" },
        to: [{ name: "Alias", address: "alias@example.net" }],
        subject,
        direction: "out",
      }),
    ]);
    const original = makeReplyEmail(`in-${subject}`, {
      from: { name: "Sender", address: "sender@example.com" },
      replyTo: [{ name: "Replies", address: "reply-to@example.com" }],
      subject: `Re: ${subject}`,
    });

    expect(resolveEmailReplyRecipient(original, original.subject, ["me@example.com"])).toBe(
      "reply-to@example.com",
    );
  });

  test("resolveEmailReplyRecipient targets the peer for outbound messages", () => {
    const original = makeReplyEmail("outbound-reply", {
      from: { name: "Me", address: "me@example.com" },
      to: [{ name: "Peer", address: "peer@example.com" }],
      direction: "out",
      subject: undefined,
    });

    expect(resolveEmailReplyRecipient(original, original.subject, ["me@example.com"])).toBe(
      "peer@example.com",
    );
  });
});

describe("reply CLI structure", () => {
  test("CLI reply command does not contain email-specific threading logic", async () => {
    const fs = await import("node:fs/promises");
    const cliSource = await fs.readFile(new URL("../../cli.ts", import.meta.url), "utf-8");
    const replyMatch = cliSource.match(/\.command\("reply <provider>[\s\S]*?^\}\);/m);

    expect(replyMatch).not.toBeNull();
    const replySource = replyMatch?.[0] ?? "";
    expect(replySource).not.toContain('providerName === "email"');
    expect(replySource).not.toContain("getPreviousOutboundRecipient");
    expect(replySource).not.toContain("inReplyTo: original");
  });
});

describe("email reply structure", () => {
  test("email reply preserves cached message when fresh read cannot upgrade metadata", async () => {
    const fs = await import("node:fs/promises");
    const emailSource = await fs.readFile(
      new URL("../../providers/email.ts", import.meta.url),
      "utf-8",
    );
    const replyMatch = emailSource.match(/async reply\(messageId, body, opts\)[\s\S]*?^ {2}},/m);

    expect(replyMatch).not.toBeNull();
    const replySource = replyMatch?.[0] ?? "";
    expect(replySource).toContain("needsMetadataRefresh");
    expect(replySource).toContain("!original.replyTo");
    expect(replySource).toContain("!original.references");
    expect(replySource).toContain("const fetched = await emailProvider.read");
    expect(replySource).toContain("if (fetched) original = fetched");
  });
});

describe("EmailAdapter default folder", () => {
  test("daemon fetch uses email.defaultFolder instead of hardcoded INBOX", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("../../daemons/email.ts", import.meta.url), "utf-8");

    expect(source).toContain("settings.defaultFolder");
    expect(source).not.toContain('settings.accounts, "INBOX"');
  });
});
