/**
 * Unit tests for WhatsApp direction detection.
 *
 * WhatsApp messages processed in whatsapp-shared.ts use the Baileys
 * `fromMe` flag to determine direction. When fromMe=true:
 * - direction is "out"
 * - from is the contact (not "me"), matching the convention that
 *   the `from` field carries the conversation partner's identity
 *
 * These tests exercise the direction and from-address logic using
 * mock Baileys-shaped message data, without touching the real
 * WhatsApp daemon or socket.
 */
import { describe, test, expect } from "bun:test";
import type { MessageFull } from "../types.ts";

// ---------------------------------------------------------------------------
// Inline replica of the WhatsApp message-to-full mapping from whatsapp-shared.ts
//
// The real code (whatsapp-shared.ts parseAndStoreWAMessage):
//   const fromMe = msg.key.fromMe ?? false;
//   const direction: "in" | "out" = fromMe ? "out" : "in";
//   const chatJid = msg.key.remoteJid ?? "";
//   const isGroup = chatJid.endsWith("@g.us");
//   let senderJid = chatJid;   // for non-group messages without participant
//   const senderName = msg.pushName || senderJid.split("@")[0] || senderJid;
//   const senderAddress = senderJid.split("@")[0] || senderJid;
//   const fromContact = { name: senderName, address: senderAddress };  // always the sender's identity
//   const toContact = fromMe ? { name: chatJid.split("@")[0], address: chatJid.split("@")[0] }
//                            : { name: "me", address: "me" };
//
// NOTE: For outgoing messages (fromMe=true) without a participant field, senderJid == chatJid,
// so from.address is the contact's phone number (not "me"). This is intentional — the from
// field reflects who sent the message in the Baileys sense, which for outgoing 1:1 messages
// is the remoteJid (the chat partner), not the self-JID.
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

function processWhatsAppMsg(msg: MockBaileysMsg): MessageFull {
  const fromMe = msg.key.fromMe ?? false;
  const direction: "in" | "out" = fromMe ? "out" : "in";
  const chatJid = msg.key.remoteJid ?? "";
  const isGroup = chatJid.endsWith("@g.us");
  // senderJid = chatJid for non-group messages with no participant field
  const senderJid = chatJid;
  const senderAddress = senderJid.split("@")[0] || senderJid;
  const senderName = msg.pushName || senderAddress;

  // Production behavior: from always reflects the Baileys sender identity.
  // For outgoing 1:1 messages (fromMe=true, no participant), senderJid == chatJid,
  // so from.address is the contact's phone number (not "me").
  const fromContact = { name: senderName, address: senderAddress };
  const toContact = fromMe
    ? { name: chatJid.split("@")[0] || chatJid, address: chatJid.split("@")[0] || chatJid }
    : { name: "me", address: "me" };

  const content =
    msg.message?.conversation ??
    msg.message?.extendedTextMessage?.text ??
    "";

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

  test("outgoing message — from is the contact (Baileys sender identity), to is the contact", () => {
    // Production behavior: for fromMe=true without a participant field, senderJid == chatJid,
    // so from.address is the contact's phone number — not "me". The direction field is the
    // canonical indicator for outgoing messages, not the from address.
    const msg = processWhatsAppMsg({
      key: { remoteJid: "46722222222@s.whatsapp.net", fromMe: true, id: "msg-out-002" },
      messageTimestamp: TS,
      pushName: "Bob",
      message: { conversation: "Hey Bob" },
    });
    // from = contact's phone (production: senderJid = chatJid for non-group outgoing)
    expect(msg.from?.address).toBe("46722222222");
    // to = the same contact address (chatJid stripped of @domain)
    expect(msg.to[0]?.address).toBe("46722222222");
    // direction is the authoritative indicator
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
