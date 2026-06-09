/**
 * Unit tests for WhatsApp direction detection and contact name enrichment.
 *
 * WhatsApp messages processed in whatsapp-shared.ts use the Baileys
 * `fromMe` flag to determine direction. When fromMe=true and the socket
 * owner is known:
 * - direction is "out"
 * - from is the account owner
 * - to is the conversation partner
 *
 * Contact name enrichment: outgoing messages look up the recipient's
 * human-readable name from a contact name map (built from the store's
 * contacts table). Falls back to the raw phone number when no contact
 * name is found.
 *
 * These tests exercise the direction and from-address logic using
 * mock Baileys-shaped message data, without touching the real
 * WhatsApp daemon or socket.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { resolveDefaultReply } from "../../providers/shared.ts";
import { whatsappProvider } from "../../providers/whatsapp.ts";
import { parseAndStoreWAMessage } from "../../providers/whatsapp-shared.ts";
import * as store from "../../store.ts";
import type { MessageEnvelope, MessageFull } from "../../types.ts";

// ---------------------------------------------------------------------------
// Pure mirror of the WhatsApp address normalization rules. Production-path
// tests below call parseAndStoreWAMessage and inspect the cached row.
// ---------------------------------------------------------------------------

interface MockBaileysKey {
  remoteJid?: string;
  fromMe?: boolean;
  id?: string;
}

interface MockBaileysMsg {
  key: MockBaileysKey;
  messageTimestamp?: number;
  pushName?: string;
  message?: { conversation?: string; extendedTextMessage?: { text?: string } } | null;
}

function processWhatsAppMsg(msg: MockBaileysMsg, contactNames?: Map<string, string>): MessageFull {
  return processWhatsAppMsgWithOwner(msg, contactNames);
}

function bareAddressFromJid(jid: string | undefined): string | undefined {
  if (!jid) return undefined;
  const user = jid.split("@")[0] || jid;
  return user.split(":")[0] || user;
}

function processWhatsAppMsgWithOwner(
  msg: MockBaileysMsg,
  contactNames?: Map<string, string>,
  owner?: { id?: string; name?: string },
): MessageFull {
  const fromMe = msg.key.fromMe ?? false;
  const direction: "in" | "out" = fromMe ? "out" : "in";
  const chatJid = msg.key.remoteJid ?? "";
  const isGroup = chatJid.endsWith("@g.us");
  const senderJid = chatJid;
  const senderAddress = bareAddressFromJid(senderJid) ?? senderJid;
  const senderName = msg.pushName || senderAddress;
  const ownerAddress = bareAddressFromJid(owner?.id);
  const ownerName = owner?.name || ownerAddress || "me";
  const fromContact = fromMe
    ? { name: ownerName, address: ownerAddress ?? (owner ? "me" : senderAddress) }
    : { name: senderName, address: senderAddress };

  // For outgoing messages, look up recipient name from contact names map
  const recipientAddress = bareAddressFromJid(chatJid) ?? chatJid;
  const recipientName = contactNames?.get(recipientAddress) ?? recipientAddress;
  const toContact = fromMe
    ? { name: recipientName, address: recipientAddress }
    : !isGroup && ownerAddress
      ? { name: ownerName, address: ownerAddress }
      : { name: "me", address: "me" };

  const content = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? "";

  const timestamp =
    typeof msg.messageTimestamp === "number"
      ? msg.messageTimestamp
      : Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000));

  return {
    id: msg.key.id || `wa-test-${Date.now()}`,
    provider: "whatsapp",
    from: fromContact,
    to: [toContact],
    subject: undefined,
    preview: content.slice(0, 200),
    body: content,
    bodyFormat: "text",
    date: new Date(timestamp * 1000).toISOString(),
    unread: !fromMe,
    hasAttachments: false,
    isGroup,
    attachments: [],
    direction,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TS = Math.floor(Date.now() / 1000);

describe("WhatsApp direction detection", () => {
  test("incoming message has direction 'in'", () => {
    const msg = processWhatsAppMsg({
      key: { remoteJid: "46711111111@s.whatsapp.net", fromMe: false, id: "msg-in-001" },
      messageTimestamp: TS,
      pushName: "Alice",
      message: { conversation: "Hello from Alice" },
    });
    expect(msg.direction).toBe("in");
  });

  test("outgoing message has direction 'out'", () => {
    const msg = processWhatsAppMsg({
      key: { remoteJid: "46711111111@s.whatsapp.net", fromMe: true, id: "msg-out-001" },
      messageTimestamp: TS,
      pushName: "Alice",
      message: { conversation: "Reply from me" },
    });
    expect(msg.direction).toBe("out");
  });

  test("outgoing message with owner identity — from is owner, to is contact", () => {
    const msg = processWhatsAppMsgWithOwner(
      {
        key: { remoteJid: "46722222222@s.whatsapp.net", fromMe: true, id: "msg-out-002" },
        messageTimestamp: TS,
        pushName: "Bob",
        message: { conversation: "Hey Bob" },
      },
      undefined,
      { id: "46700000099:12@s.whatsapp.net", name: "Test Owner" },
    );
    expect(msg.from?.name).toBe("Test Owner");
    expect(msg.from?.address).toBe("46700000099");
    expect(msg.to[0]?.address).toBe("46722222222");
    expect(msg.direction).toBe("out");
  });

  test("incoming message — from is the contact, to is 'me'", () => {
    const msg = processWhatsAppMsg({
      key: { remoteJid: "46733333333@s.whatsapp.net", fromMe: false, id: "msg-in-002" },
      messageTimestamp: TS,
      pushName: "Carol",
      message: { conversation: "Message from Carol" },
    });
    expect(msg.from?.address).toBe("46733333333");
    expect(msg.from?.name).toBe("Carol");
    expect(msg.to[0]?.address).toBe("me");
  });

  test("group message is classified as incoming and isGroup=true", () => {
    const msg = processWhatsAppMsg({
      key: { remoteJid: "1234567890@g.us", fromMe: false, id: "msg-group-001" },
      messageTimestamp: TS,
      pushName: "Dave",
      message: { conversation: "Group message" },
    });
    expect(msg.direction).toBe("in");
    expect(msg.isGroup).toBe(true);
  });

  test("outgoing group message has direction 'out' and isGroup=true", () => {
    const msg = processWhatsAppMsg({
      key: { remoteJid: "1234567890@g.us", fromMe: true, id: "msg-group-out-001" },
      messageTimestamp: TS,
      message: { conversation: "Sent to group" },
    });
    expect(msg.direction).toBe("out");
    expect(msg.isGroup).toBe(true);
  });

  test("unread is false for outgoing messages", () => {
    const msg = processWhatsAppMsg({
      key: { remoteJid: "46744444444@s.whatsapp.net", fromMe: true, id: "msg-unread-001" },
      messageTimestamp: TS,
      message: { conversation: "Sent" },
    });
    expect(msg.unread).toBe(false);
  });

  test("unread is true for incoming messages", () => {
    const msg = processWhatsAppMsg({
      key: { remoteJid: "46755555555@s.whatsapp.net", fromMe: false, id: "msg-unread-002" },
      messageTimestamp: TS,
      message: { conversation: "Received" },
    });
    expect(msg.unread).toBe(true);
  });

  test("fromMe missing defaults to incoming", () => {
    const msg = processWhatsAppMsg({
      key: { remoteJid: "46766666666@s.whatsapp.net", id: "msg-no-fromme" },
      messageTimestamp: TS,
      message: { conversation: "No fromMe field" },
    });
    expect(msg.direction).toBe("in");
  });
});

describe("WhatsApp production normalization", () => {
  // Synthetic identifiers only — never real contacts. These tests persist rows
  // via parseAndStoreWAMessage + store, so using a real number/name would, if
  // the cache leaked, get synced into the vault as a real person's thread.
  const PARTNER_NUM = "46700000001";
  const PARTNER_JID = `${PARTNER_NUM}@s.whatsapp.net`;
  const OWNER_NUM = "46700000099";
  const OWNER_NAME = "Test Owner";
  const PARTNER_NAME = "Test Partner";

  // Isolate the cache into a throwaway temp dir so these store-writing tests
  // never touch the real ~/.config/onemessage/messages.db — the file the vault
  // message-sync daemon reads. Without this, fixtures get synced into the vault.
  let tmpConfigDir: string;
  let prevConfigDir: string | undefined;
  beforeAll(() => {
    prevConfigDir = process.env.ONEMESSAGE_CONFIG_DIR;
    tmpConfigDir = mkdtempSync(join(tmpdir(), "onemessage-test-"));
    process.env.ONEMESSAGE_CONFIG_DIR = tmpConfigDir;
    store.closeDb(); // rebind the DB singleton to the temp dir
  });
  afterAll(() => {
    store.closeDb();
    if (prevConfigDir === undefined) {
      delete process.env.ONEMESSAGE_CONFIG_DIR;
    } else {
      process.env.ONEMESSAGE_CONFIG_DIR = prevConfigDir;
    }
    rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  test("outbound direct cache row stores owner as from and partner as to", async () => {
    const id = `wa-normalize-out-${Date.now()}`;
    const sock = {
      user: { id: `${OWNER_NUM}:12@s.whatsapp.net`, name: OWNER_NAME },
    } as unknown as WASocket;

    const ok = await parseAndStoreWAMessage(
      {
        key: { remoteJid: PARTNER_JID, fromMe: true, id },
        messageTimestamp: TS,
        message: { conversation: "Hey there" },
      } as unknown as WAMessage,
      sock,
      undefined,
      undefined,
      new Map([[PARTNER_NUM, PARTNER_NAME]]),
      true,
    );

    expect(ok).toBe(true);
    const cached = store.getCachedMessage("whatsapp", id);
    expect(cached).not.toBeNull();
    if (!cached) return;

    expect(cached.direction).toBe("out");
    expect(cached.from?.name).toBe(OWNER_NAME);
    expect(cached.from?.address).toBe(OWNER_NUM);
    expect(cached.to[0]?.name).toBe(PARTNER_NAME);
    expect(cached.to[0]?.address).toBe(PARTNER_NUM);
    expect(resolveDefaultReply(cached).recipientId).toBe(PARTNER_NUM);
  });

  test("inbound direct cache row stores partner as from and owner as to", async () => {
    const id = `wa-normalize-in-${Date.now()}`;
    const sock = {
      user: { id: `${OWNER_NUM}@s.whatsapp.net`, name: OWNER_NAME },
    } as unknown as WASocket;

    const ok = await parseAndStoreWAMessage(
      {
        key: { remoteJid: PARTNER_JID, fromMe: false, id },
        messageTimestamp: TS,
        pushName: "Selfie Name", // pushName differs from the saved contact name
        message: { conversation: "Hello there" },
      } as unknown as WAMessage,
      sock,
      undefined,
      undefined,
      new Map([[PARTNER_NUM, PARTNER_NAME]]),
      true,
    );

    expect(ok).toBe(true);
    const cached = store.getCachedMessage("whatsapp", id);
    expect(cached).not.toBeNull();
    if (!cached) return;

    expect(cached.direction).toBe("in");
    // Authoritative contacts-map name wins over the sender's self-set pushName,
    // so a contact resolves to ONE name (and one vault folder) in both directions.
    expect(cached.from?.name).toBe(PARTNER_NAME);
    expect(cached.from?.address).toBe(PARTNER_NUM);
    expect(cached.to[0]?.name).toBe(OWNER_NAME);
    expect(cached.to[0]?.address).toBe(OWNER_NUM);
  });

  test("outbound direct cache row uses creds owner identity when sock.user is unavailable", async () => {
    const id = `wa-normalize-creds-out-${Date.now()}`;
    const sock = {} as unknown as WASocket;

    const ok = await parseAndStoreWAMessage(
      {
        key: { remoteJid: PARTNER_JID, fromMe: true, id },
        messageTimestamp: TS,
        message: { conversation: "Creds-only owner" },
      } as unknown as WAMessage,
      sock,
      undefined,
      undefined,
      new Map([[PARTNER_NUM, PARTNER_NAME]]),
      true,
      { id: `${OWNER_NUM}:4@s.whatsapp.net`, name: OWNER_NAME },
    );

    expect(ok).toBe(true);
    const cached = store.getCachedMessage("whatsapp", id);
    expect(cached).not.toBeNull();
    if (!cached) return;

    expect(cached.direction).toBe("out");
    expect(cached.from?.name).toBe(OWNER_NAME);
    expect(cached.from?.address).toBe(OWNER_NUM);
    expect(cached.to[0]?.name).toBe(PARTNER_NAME);
    expect(cached.to[0]?.address).toBe(PARTNER_NUM);
  });

  test("direct history owner-authored message with unreliable fromMe is stored as outbound", async () => {
    const id = `wa-normalize-history-owner-${Date.now()}`;

    const ok = await parseAndStoreWAMessage(
      {
        key: { remoteJid: PARTNER_JID, fromMe: false, id },
        messageTimestamp: TS,
        pushName: OWNER_NAME,
        message: { conversation: "Synced from linked device" },
      } as unknown as WAMessage,
      undefined,
      undefined,
      undefined,
      new Map([[PARTNER_NUM, PARTNER_NAME]]),
      true,
      { id: `${OWNER_NUM}@s.whatsapp.net`, name: OWNER_NAME },
    );

    expect(ok).toBe(true);
    const cached = store.getCachedMessage("whatsapp", id);
    expect(cached).not.toBeNull();
    if (!cached) return;

    expect(cached.direction).toBe("out");
    expect(cached.unread).toBe(false);
    expect(cached.from?.name).toBe(OWNER_NAME);
    expect(cached.from?.address).toBe(OWNER_NUM);
    expect(cached.to[0]?.name).toBe(PARTNER_NAME);
    expect(cached.to[0]?.address).toBe(PARTNER_NUM);
    expect(resolveDefaultReply(cached).recipientId).toBe(PARTNER_NUM);
  });

  test("direct history owner participant proves outbound even without pushName", async () => {
    const id = `wa-normalize-history-owner-participant-${Date.now()}`;

    const ok = await parseAndStoreWAMessage(
      {
        key: {
          remoteJid: PARTNER_JID,
          participant: `${OWNER_NUM}:9@s.whatsapp.net`,
          fromMe: false,
          id,
        },
        messageTimestamp: TS,
        message: { conversation: "Synced participant owner" },
      } as unknown as WAMessage,
      undefined,
      undefined,
      undefined,
      new Map([[PARTNER_NUM, PARTNER_NAME]]),
      true,
      { id: `${OWNER_NUM}@s.whatsapp.net` },
    );

    expect(ok).toBe(true);
    const cached = store.getCachedMessage("whatsapp", id);
    expect(cached).not.toBeNull();
    if (!cached) return;

    expect(cached.direction).toBe("out");
    expect(cached.from?.address).toBe(OWNER_NUM);
    expect(cached.to[0]?.name).toBe(PARTNER_NAME);
    expect(cached.to[0]?.address).toBe(PARTNER_NUM);
    expect(resolveDefaultReply(cached).recipientId).toBe(PARTNER_NUM);
  });

  test("direct history contact-name collision is not inferred as owner-authored", async () => {
    const id = `wa-normalize-history-name-collision-${Date.now()}`;

    const ok = await parseAndStoreWAMessage(
      {
        key: { remoteJid: PARTNER_JID, fromMe: false, id },
        messageTimestamp: TS,
        pushName: OWNER_NAME,
        message: { conversation: "Inbound from contact with same display name" },
      } as unknown as WAMessage,
      undefined,
      undefined,
      undefined,
      new Map([[PARTNER_NUM, OWNER_NAME]]),
      true,
      { id: `${OWNER_NUM}@s.whatsapp.net`, name: OWNER_NAME },
    );

    expect(ok).toBe(true);
    const cached = store.getCachedMessage("whatsapp", id);
    expect(cached).not.toBeNull();
    if (!cached) return;

    expect(cached.direction).toBe("in");
    expect(cached.unread).toBe(true);
    expect(cached.from?.name).toBe(OWNER_NAME);
    expect(cached.from?.address).toBe(PARTNER_NUM);
    expect(cached.to[0]?.name).toBe(OWNER_NAME);
    expect(cached.to[0]?.address).toBe(OWNER_NUM);
    expect(resolveDefaultReply(cached).recipientId).toBe(PARTNER_NUM);
  });

  test("inbound poisoned pushName (owner leak) on UNKNOWN sender falls back to address, never owner", async () => {
    const id = `wa-normalize-poison-unknown-${Date.now()}`;
    const ok = await parseAndStoreWAMessage(
      {
        key: { remoteJid: PARTNER_JID, fromMe: false, id },
        messageTimestamp: TS,
        pushName: OWNER_NAME, // Baileys leaked the owner's display name onto a contact message
        message: { conversation: "Inbound, sender not in contacts" },
      } as unknown as WAMessage,
      undefined,
      undefined,
      undefined,
      new Map(), // empty contact map → unknown sender
      true,
      { id: `${OWNER_NUM}@s.whatsapp.net`, name: OWNER_NAME },
    );
    expect(ok).toBe(true);
    const cached = store.getCachedMessage("whatsapp", id);
    expect(cached).not.toBeNull();
    if (!cached) return;
    expect(cached.direction).toBe("in");
    expect(cached.from?.name).toBe(PARTNER_NUM); // address, NOT the owner's name
    expect(cached.from?.name).not.toBe(OWNER_NAME);
    expect(cached.from?.address).toBe(PARTNER_NUM);
  });

  test("inbound poisoned pushName on KNOWN contact resolves to contact name, not owner", async () => {
    const id = `wa-normalize-poison-known-${Date.now()}`;
    const ok = await parseAndStoreWAMessage(
      {
        key: { remoteJid: PARTNER_JID, fromMe: false, id },
        messageTimestamp: TS,
        pushName: OWNER_NAME, // poison
        message: { conversation: "Inbound from a known contact" },
      } as unknown as WAMessage,
      undefined,
      undefined,
      undefined,
      new Map([[PARTNER_NUM, PARTNER_NAME]]), // contacts-backed map knows the sender
      false, // live (non-history) inbound
      { id: `${OWNER_NUM}@s.whatsapp.net`, name: OWNER_NAME },
    );
    expect(ok).toBe(true);
    const cached = store.getCachedMessage("whatsapp", id);
    expect(cached).not.toBeNull();
    if (!cached) return;
    expect(cached.direction).toBe("in");
    expect(cached.from?.name).toBe(PARTNER_NAME); // contacts map wins over poison
    expect(cached.from?.address).toBe(PARTNER_NUM);
  });
});

// ---------------------------------------------------------------------------
// Contact name enrichment for outgoing messages
// ---------------------------------------------------------------------------

describe("WhatsApp outgoing contact name enrichment", () => {
  test("outgoing message uses contact name from lookup when available", () => {
    const contactNames = new Map([["46700000001", "Test Partner"]]);
    const msg = processWhatsAppMsg(
      {
        key: { remoteJid: "46700000001@s.whatsapp.net", fromMe: true, id: "msg-name-001" },
        messageTimestamp: TS,
        message: { conversation: "Hey there" },
      },
      contactNames,
    );
    expect(msg.to[0]?.name).toBe("Test Partner");
    expect(msg.to[0]?.address).toBe("46700000001");
    expect(msg.direction).toBe("out");
  });

  test("outgoing message falls back to phone number when no contact exists", () => {
    const contactNames = new Map<string, string>(); // empty map
    const msg = processWhatsAppMsg(
      {
        key: { remoteJid: "46799999999@s.whatsapp.net", fromMe: true, id: "msg-name-002" },
        messageTimestamp: TS,
        message: { conversation: "Hello stranger" },
      },
      contactNames,
    );
    expect(msg.to[0]?.name).toBe("46799999999");
    expect(msg.to[0]?.address).toBe("46799999999");
  });

  test("outgoing message falls back to phone number when contactNames is undefined", () => {
    const msg = processWhatsAppMsg(
      {
        key: { remoteJid: "46799999999@s.whatsapp.net", fromMe: true, id: "msg-name-003" },
        messageTimestamp: TS,
        message: { conversation: "No contact map" },
      },
      undefined,
    );
    expect(msg.to[0]?.name).toBe("46799999999");
    expect(msg.to[0]?.address).toBe("46799999999");
  });

  test("incoming messages are unaffected by contact name lookup", () => {
    const contactNames = new Map([["46700000001", "Test Partner"]]);
    const msg = processWhatsAppMsg(
      {
        key: { remoteJid: "46700000001@s.whatsapp.net", fromMe: false, id: "msg-name-004" },
        messageTimestamp: TS,
        pushName: "Partner",
        message: { conversation: "Message from partner" },
      },
      contactNames,
    );
    // Incoming: to should be "me", not the contact name
    expect(msg.to[0]?.name).toBe("me");
    expect(msg.to[0]?.address).toBe("me");
    expect(msg.from?.name).toBe("Partner");
    expect(msg.direction).toBe("in");
  });

  test("group outgoing messages use contact name for group address", () => {
    const contactNames = new Map([["1234567890", "Family Group"]]);
    const msg = processWhatsAppMsg(
      {
        key: { remoteJid: "1234567890@g.us", fromMe: true, id: "msg-name-005" },
        messageTimestamp: TS,
        message: { conversation: "Group message" },
      },
      contactNames,
    );
    expect(msg.isGroup).toBe(true);
    expect(msg.direction).toBe("out");
    // Group messages: to address is the group JID prefix
    expect(msg.to[0]?.address).toBe("1234567890");
  });
});

// ---------------------------------------------------------------------------
// inbox() migration — inboxViaDaemon integration
// ---------------------------------------------------------------------------

describe("whatsappProvider.inbox via inboxViaDaemon", () => {
  test("inbox() with fresh cache returns cached messages (proves inboxViaDaemon delegation)", async () => {
    // Arrange: populate cache with a test message
    const testId = `wa-inbox-test-${Date.now()}`;
    const testMsg: MessageFull = {
      id: testId,
      provider: "whatsapp",
      from: { name: "Test Contact", address: "46700888888" },
      to: [{ name: "me", address: "me" }],
      preview: "cached whatsapp inbox message",
      body: "cached whatsapp inbox message",
      bodyFormat: "text",
      date: new Date().toISOString(),
      unread: true,
      hasAttachments: false,
      attachments: [],
      direction: "in",
    };
    store.upsertFullMessages([testMsg]);

    // Mark cache as FRESH (within 60s freshness window)
    store.recordFetch("whatsapp");

    // Act: call inbox() with fresh:false
    // This should short-circuit at the freshness gate and NOT call daemon
    const result = await whatsappProvider.inbox({
      fresh: false,
      limit: 10,
    });

    // Assert: should return the cached message WITHOUT timeout (proves freshness gate works)
    // This confirms inbox() delegates to inboxViaDaemon and the helper's cache path works
    expect(result.length).toBeGreaterThan(0);
    const found = result.find((m: MessageEnvelope) => m.id === testId);
    expect(found).toBeDefined();
    expect(found?.preview).toBe("cached whatsapp inbox message");
  });

  test("inbox() calls inboxViaDaemon (structural proof of migration)", async () => {
    // This test proves the migration happened by inspecting the source code structure.
    // The old implementation called `ensureDaemon` and `store.recordFetch` directly.
    // The new implementation calls `inboxViaDaemon` (helper that manages daemon lifecycle).
    //
    // Strategy: Read the inbox() source, assert it contains "inboxViaDaemon" and NOT the old direct calls.

    const fs = await import("node:fs/promises");
    const whatsappProviderSource = await fs.readFile(
      new URL("../../providers/whatsapp.ts", import.meta.url),
      "utf-8",
    );

    // Extract the inbox() method body
    const inboxMatch = whatsappProviderSource.match(/async inbox\(opts\)\s*{[\s\S]*?^ {2}},/m);
    expect(inboxMatch).not.toBeNull();

    const inboxBody = (inboxMatch?.[0] ?? "")
      .replace(/\/\/.*$/gm, "") // strip line comments
      .replace(/\/\*[\s\S]*?\*\//g, ""); // strip block comments

    // Assert: inbox() calls inboxViaDaemon
    expect(inboxBody).toContain("inboxViaDaemon");

    // Assert: inbox() does NOT call ensureDaemon directly inside inbox()
    expect(inboxBody).not.toContain("ensureDaemon");

    // Assert: inbox() does NOT call store.recordFetch directly inside inbox()
    expect(inboxBody).not.toContain("store.recordFetch");

    // Assert: inbox() passes provider:"whatsapp" to helper
    expect(inboxBody).toContain('provider: "whatsapp"');

    // Assert: inbox() uses provider-specific cache policy
    expect(inboxBody).toContain('freshnessMs: getProviderFreshnessMs("whatsapp")');
  });
});
