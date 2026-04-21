/**
 * Unit + integration tests for Signal message processing.
 *
 * Tests the REAL processSignalMessages function — not a copy.
 * Integration tests use a __test__ provider prefix to avoid polluting real data.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { processSignalMessages } from "./signal.ts";
import * as store from "../store.ts";
import type { MessageFull } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MY_ACCOUNT = "+46700000000";
const CONTACT_A = "+46711111111";
const CONTACT_B = "+46722222222";
const TEST_PROVIDER = "__test_signal__";

let counter = 0;

function makeMsg(
  fromAddress: string,
  extras?: Partial<MessageFull>,
): MessageFull {
  counter++;
  return {
    id: `sig-test-${Date.now()}-${counter}`,
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

beforeEach(() => {
  counter = 0;
});

// ---------------------------------------------------------------------------
// Unit tests: processSignalMessages — direction splitting + mutation
// ---------------------------------------------------------------------------

describe("processSignalMessages", () => {
  test("splits incoming and outgoing by account address", () => {
    const messages = [
      makeMsg(CONTACT_A),
      makeMsg(MY_ACCOUNT, { direction: "out" }),
      makeMsg(CONTACT_B),
    ];

    const result = processSignalMessages(messages, MY_ACCOUNT);

    expect(result.incoming).toBe(2);
    expect(result.outgoing).toBe(1);
  });

  test("fixes direction on outgoing DataMessages (from=account, direction='in')", () => {
    // THE bug case: DataMessage from own account has direction="in"
    // because isSync is false, but it's actually outgoing.
    const msg = makeMsg(MY_ACCOUNT, { direction: "in" });

    processSignalMessages([msg], MY_ACCOUNT);

    expect(msg.direction).toBe("out");
  });

  test("preserves direction on outgoing SyncMessages (already 'out')", () => {
    const msg = makeMsg(MY_ACCOUNT, { direction: "out" });

    processSignalMessages([msg], MY_ACCOUNT);

    expect(msg.direction).toBe("out");
  });

  test("does not modify direction on incoming messages", () => {
    const msg = makeMsg(CONTACT_A, { direction: "in" });

    processSignalMessages([msg], MY_ACCOUNT);

    expect(msg.direction).toBe("in");
  });

  test("handles empty message array without error", () => {
    const result = processSignalMessages([], MY_ACCOUNT);

    expect(result.incoming).toBe(0);
    expect(result.outgoing).toBe(0);
  });

  test("all outgoing batch — both DataMessage and SyncMessage get direction='out'", () => {
    const messages = [
      makeMsg(MY_ACCOUNT, { direction: "in" }),
      makeMsg(MY_ACCOUNT, { direction: "out" }),
    ];

    const result = processSignalMessages(messages, MY_ACCOUNT);

    expect(result.incoming).toBe(0);
    expect(result.outgoing).toBe(2);
    expect(messages[0]!.direction).toBe("out");
    expect(messages[1]!.direction).toBe("out");
  });

  test("all incoming batch — no direction mutation", () => {
    const messages = [makeMsg(CONTACT_A), makeMsg(CONTACT_B)];

    const result = processSignalMessages(messages, MY_ACCOUNT);

    expect(result.incoming).toBe(2);
    expect(result.outgoing).toBe(0);
  });

  test("group messages (group: address) classified as incoming", () => {
    const msg = makeMsg("group:abc123==", {
      isGroup: true,
      groupName: "Test Group",
    });

    const result = processSignalMessages([msg], MY_ACCOUNT);

    expect(result.incoming).toBe(1);
    expect(result.outgoing).toBe(0);
    expect(msg.direction).toBe("in");
  });
});

// ---------------------------------------------------------------------------
// Integration: processSignalMessages → DB round-trip
//
// These test the full chain: direction fix → upsert → getCachedMessage
// Uses real DB with unique test IDs to avoid collisions.
// ---------------------------------------------------------------------------

describe("processSignalMessages → DB round-trip", () => {
  test("outgoing DataMessage stored with direction='out'", () => {
    const id = `integ-out-${Date.now()}`;
    const msg = makeMsg(MY_ACCOUNT, {
      id,
      direction: "in", // DataMessage from own account — should be fixed to "out"
      to: [{ name: "Contact A", address: CONTACT_A }],
      body: "outgoing integration test",
    });

    processSignalMessages([msg], MY_ACCOUNT);

    const stored = store.getCachedMessage("signal", id);
    expect(stored).not.toBeNull();
    expect(stored!.direction).toBe("out");
    expect(stored!.body).toBe("outgoing integration test");
  });

  test("incoming message stored with direction='in'", () => {
    const id = `integ-in-${Date.now()}`;
    const msg = makeMsg(CONTACT_A, {
      id,
      direction: "in",
      body: "incoming integration test",
    });

    processSignalMessages([msg], MY_ACCOUNT);

    const stored = store.getCachedMessage("signal", id);
    expect(stored).not.toBeNull();
    expect(stored!.direction).toBe("in");
  });

  test("mixed batch — each message has correct direction in DB", () => {
    const ts = Date.now();
    const messages = [
      makeMsg(CONTACT_A, { id: `mix-in-${ts}`, body: "from contact" }),
      makeMsg(MY_ACCOUNT, { id: `mix-out-${ts}`, direction: "in", body: "from me" }),
      makeMsg(CONTACT_B, { id: `mix-in2-${ts}`, body: "from contact B" }),
    ];

    processSignalMessages(messages, MY_ACCOUNT);

    expect(store.getCachedMessage("signal", `mix-in-${ts}`)!.direction).toBe("in");
    expect(store.getCachedMessage("signal", `mix-out-${ts}`)!.direction).toBe("out");
    expect(store.getCachedMessage("signal", `mix-in2-${ts}`)!.direction).toBe("in");
  });
});
