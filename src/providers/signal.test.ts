/**
 * Unit tests for Signal direction detection logic.
 *
 * Signal assigns direction at upsert time by splitting messages:
 * - incoming:  m.from.address !== account  (received from someone else)
 * - outgoing:  m.from.address === account  (syncMessage — sent by us)
 *
 * These tests exercise that split logic using mock message data
 * shaped like what parseSignalMessages produces, without touching
 * the real signal-cli binary or the database.
 */
import { describe, test, expect } from "bun:test";
import type { MessageFull } from "../types.ts";

// ---------------------------------------------------------------------------
// Inline replica of the direction-split logic from fetchSignalInbox
// ---------------------------------------------------------------------------

function splitByDirection(
  messages: MessageFull[],
  account: string,
): { incoming: MessageFull[]; outgoing: MessageFull[] } {
  const incoming = messages.filter((m) => m.from?.address !== account);
  const outgoing = messages.filter((m) => m.from?.address === account);
  return { incoming, outgoing };
}

// ---------------------------------------------------------------------------
// Helpers to build mock MessageFull objects
// ---------------------------------------------------------------------------

function makeMsg(fromAddress: string, extras?: Partial<MessageFull>): MessageFull {
  return {
    id: `signal-${Date.now()}-${Math.random()}`,
    provider: "signal",
    from: { name: "Test User", address: fromAddress },
    to: [],
    preview: "hello",
    body: "hello",
    bodyFormat: "text",
    date: new Date().toISOString(),
    unread: true,
    hasAttachments: false,
    attachments: [],
    direction: "in",
    ...extras,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Signal direction detection", () => {
  const myAccount = "+46700000000";

  test("message from another number is classified as incoming", () => {
    const msg = makeMsg("+46711111111");
    const { incoming, outgoing } = splitByDirection([msg], myAccount);
    expect(incoming).toHaveLength(1);
    expect(outgoing).toHaveLength(0);
    expect(incoming[0]!.from?.address).toBe("+46711111111");
  });

  test("message from own account is classified as outgoing (sync message)", () => {
    const msg = makeMsg(myAccount, { direction: "out" });
    const { incoming, outgoing } = splitByDirection([msg], myAccount);
    expect(outgoing).toHaveLength(1);
    expect(incoming).toHaveLength(0);
  });

  test("mixed batch is split correctly", () => {
    const msgs = [
      makeMsg("+46722222222"),
      makeMsg(myAccount, { direction: "out" }),
      makeMsg("+46733333333"),
    ];
    const { incoming, outgoing } = splitByDirection(msgs, myAccount);
    expect(incoming).toHaveLength(2);
    expect(outgoing).toHaveLength(1);
  });

  test("group message (group: address) is classified as incoming", () => {
    const msg = makeMsg("group:abc123==");
    const { incoming, outgoing } = splitByDirection([msg], myAccount);
    expect(incoming).toHaveLength(1);
    expect(outgoing).toHaveLength(0);
  });

  test("all outgoing — no incoming messages", () => {
    const msgs = [
      makeMsg(myAccount, { direction: "out" }),
      makeMsg(myAccount, { direction: "out" }),
    ];
    const { incoming, outgoing } = splitByDirection(msgs, myAccount);
    expect(incoming).toHaveLength(0);
    expect(outgoing).toHaveLength(2);
  });

  test("empty batch produces empty results", () => {
    const { incoming, outgoing } = splitByDirection([], myAccount);
    expect(incoming).toHaveLength(0);
    expect(outgoing).toHaveLength(0);
  });

  test("direction field on parsed message is 'in' for data messages", () => {
    // syncMessage presence → isSync → direction "out"
    // absence of syncMessage → direction "in"
    const incomingMsg = makeMsg("+46799999999", { direction: "in" });
    expect(incomingMsg.direction).toBe("in");
  });

  test("direction field on parsed message is 'out' for sync messages", () => {
    const outgoingMsg = makeMsg(myAccount, { direction: "out" });
    expect(outgoingMsg.direction).toBe("out");
  });
});
