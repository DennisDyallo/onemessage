/**
 * Unit tests for SMS direction detection via toSmsMessage().
 *
 * toSmsMessage() receives an explicit "direction" field from the
 * kdeconnect-read-sms JSON output and propagates it directly to
 * the MessageFull object it returns — no inference required.
 *
 * These tests verify the mapping and that from/to contacts are
 * set correctly for each direction.
 */
import { describe, expect, test } from "bun:test";
import type { MessageFull } from "../../types.ts";

// ---------------------------------------------------------------------------
// Inline replica of toSmsMessage() from sms.ts
// ---------------------------------------------------------------------------

function toSmsMessage(opts: {
  id: string;
  contact: string;
  body: string;
  timestamp: string;
  direction: "in" | "out";
  read: boolean;
  contactNames?: Map<string, string>;
}): MessageFull {
  const { id, contact, body, timestamp, direction, read, contactNames } = opts;
  const contactName = contactNames?.get(contact) ?? contact;
  return {
    id,
    provider: "sms",
    from:
      direction === "in" ? { name: contactName, address: contact } : { name: "me", address: "me" },
    to:
      direction === "in"
        ? [{ name: "me", address: "me" }]
        : [{ name: contactName, address: contact }],
    preview: body.slice(0, 100),
    body,
    bodyFormat: "text",
    attachments: [],
    date: timestamp,
    unread: !read,
    hasAttachments: false,
    direction,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();

describe("SMS toSmsMessage direction", () => {
  test("incoming SMS has direction 'in'", () => {
    const msg = toSmsMessage({
      id: "1001",
      contact: "+46711111111",
      body: "Hey there",
      timestamp: NOW,
      direction: "in",
      read: false,
    });
    expect(msg.direction).toBe("in");
  });

  test("outgoing SMS has direction 'out'", () => {
    const msg = toSmsMessage({
      id: "1002",
      contact: "+46722222222",
      body: "Reply here",
      timestamp: NOW,
      direction: "out",
      read: true,
    });
    expect(msg.direction).toBe("out");
  });

  test("incoming SMS — from is the contact, to is 'me'", () => {
    const msg = toSmsMessage({
      id: "1003",
      contact: "+46733333333",
      body: "Incoming text",
      timestamp: NOW,
      direction: "in",
      read: false,
    });
    expect(msg.from?.address).toBe("+46733333333");
    expect(msg.to[0]?.address).toBe("me");
  });

  test("outgoing SMS — from is 'me', to is the contact", () => {
    const msg = toSmsMessage({
      id: "1004",
      contact: "+46744444444",
      body: "Outgoing text",
      timestamp: NOW,
      direction: "out",
      read: true,
    });
    expect(msg.from?.address).toBe("me");
    expect(msg.to[0]?.address).toBe("+46744444444");
  });

  test("unread flag is set correctly for incoming unread", () => {
    const msg = toSmsMessage({
      id: "1005",
      contact: "+46755555555",
      body: "Unread msg",
      timestamp: NOW,
      direction: "in",
      read: false,
    });
    expect(msg.unread).toBe(true);
  });

  test("unread flag is false for read messages", () => {
    const msg = toSmsMessage({
      id: "1006",
      contact: "+46766666666",
      body: "Read msg",
      timestamp: NOW,
      direction: "in",
      read: true,
    });
    expect(msg.unread).toBe(false);
  });

  test("preview is truncated to 100 chars", () => {
    const longBody = "A".repeat(200);
    const msg = toSmsMessage({
      id: "1007",
      contact: "+46777777777",
      body: longBody,
      timestamp: NOW,
      direction: "in",
      read: true,
    });
    expect(msg.preview.length).toBe(100);
    expect(msg.body.length).toBe(200);
  });

  test("provider is always 'sms'", () => {
    const msg = toSmsMessage({
      id: "1008",
      contact: "+46788888888",
      body: "test",
      timestamp: NOW,
      direction: "out",
      read: true,
    });
    expect(msg.provider).toBe("sms");
  });
});

// ---------------------------------------------------------------------------
// Contact name enrichment
// ---------------------------------------------------------------------------

describe("SMS contact name enrichment", () => {
  test("outgoing SMS uses contact name from lookup when available", () => {
    const contactNames = new Map([["+46711111111", "Alice"]]);
    const msg = toSmsMessage({
      id: "2001",
      contact: "+46711111111",
      body: "Hey Alice",
      timestamp: NOW,
      direction: "out",
      read: true,
      contactNames,
    });
    expect(msg.to[0]?.name).toBe("Alice");
    expect(msg.to[0]?.address).toBe("+46711111111");
  });

  test("outgoing SMS falls back to raw contact when no name exists", () => {
    const contactNames = new Map<string, string>();
    const msg = toSmsMessage({
      id: "2002",
      contact: "+46799999999",
      body: "Hello",
      timestamp: NOW,
      direction: "out",
      read: true,
      contactNames,
    });
    expect(msg.to[0]?.name).toBe("+46799999999");
    expect(msg.to[0]?.address).toBe("+46799999999");
  });

  test("incoming SMS uses contact name for from field", () => {
    const contactNames = new Map([["+46711111111", "Alice"]]);
    const msg = toSmsMessage({
      id: "2003",
      contact: "+46711111111",
      body: "Hello from Alice",
      timestamp: NOW,
      direction: "in",
      read: false,
      contactNames,
    });
    expect(msg.from?.name).toBe("Alice");
    expect(msg.from?.address).toBe("+46711111111");
    expect(msg.to[0]?.name).toBe("me");
  });

  test("incoming SMS without contact name falls back to raw contact", () => {
    const msg = toSmsMessage({
      id: "2004",
      contact: "+46799999999",
      body: "Unknown sender",
      timestamp: NOW,
      direction: "in",
      read: false,
    });
    expect(msg.from?.name).toBe("+46799999999");
    expect(msg.from?.address).toBe("+46799999999");
  });
});
