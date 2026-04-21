/**
 * Unit tests for Telegram Bot transformer functions.
 *
 * Tests the REAL updateToEnvelope and updateToFull functions — not replicas.
 */
import { describe, expect, test } from "bun:test";
import type { TelegramMessage, TelegramUpdate } from "../../providers/telegram-bot.ts";
import { updateToEnvelope, updateToFull } from "../../providers/telegram-bot.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides?: Partial<TelegramMessage>): TelegramMessage {
  return {
    message_id: 100,
    date: 1700000000, // 2023-11-14T22:13:20.000Z
    chat: {
      id: 999,
      type: "private",
      first_name: "Alice",
      last_name: "Smith",
    },
    from: { id: 42, first_name: "Alice", last_name: "Smith" },
    text: "Hello world",
    ...overrides,
  };
}

function makeUpdate(overrides?: Partial<TelegramUpdate>): TelegramUpdate {
  return {
    update_id: 1,
    message: makeMessage(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// updateToEnvelope
// ---------------------------------------------------------------------------

describe("updateToEnvelope", () => {
  test("text message produces correct envelope", () => {
    const env = updateToEnvelope(makeUpdate());
    expect(env).not.toBeNull();
    expect(env?.id).toBe("1");
    expect(env?.provider).toBe("telegram-bot");
    expect(env?.from).toEqual({ name: "Alice Smith", address: "42" });
    expect(env?.to).toEqual([{ name: "Alice Smith", address: "999" }]);
    expect(env?.preview).toBe("Hello world");
    expect(env?.date).toBe(new Date(1700000000 * 1000).toISOString());
    expect(env?.unread).toBe(true);
  });

  test("channel_post is handled when message field is absent", () => {
    const update = makeUpdate({
      message: undefined,
      channel_post: makeMessage({
        chat: { id: 555, type: "channel", title: "My Channel" },
        from: undefined,
        text: "Channel announcement",
      }),
    });
    const env = updateToEnvelope(update);
    expect(env).not.toBeNull();
    expect(env?.preview).toBe("Channel announcement");
    expect(env?.from?.address).toBe("555");
  });

  test("update with neither message nor channel_post returns null", () => {
    const env = updateToEnvelope({ update_id: 99 });
    expect(env).toBeNull();
  });

  test("group/supergroup chat sets isGroup=true and populates groupName", () => {
    const groupUpdate = makeUpdate({
      message: makeMessage({
        chat: { id: 100, type: "group", title: "Dev Team" },
      }),
    });
    const env = updateToEnvelope(groupUpdate);
    expect(env?.isGroup).toBe(true);
    expect(env?.groupName).toBe("Dev Team");

    const superUpdate = makeUpdate({
      message: makeMessage({
        chat: { id: 101, type: "supergroup", title: "Big Group" },
      }),
    });
    const envSuper = updateToEnvelope(superUpdate);
    expect(envSuper?.isGroup).toBe(true);
    expect(envSuper?.groupName).toBe("Big Group");
  });

  test("private chat sets isGroup=false", () => {
    const env = updateToEnvelope(makeUpdate());
    expect(env?.isGroup).toBe(false);
  });

  test("photo/document/voice/audio/video sets hasAttachments=true", () => {
    for (const field of ["photo", "document", "voice", "audio", "video"] as const) {
      const msg = makeMessage({ [field]: field === "photo" ? [{}] : {} });
      const env = updateToEnvelope(makeUpdate({ message: msg }));
      expect(env?.hasAttachments).toBe(true);
    }
  });

  test("preview is truncated to 100 characters", () => {
    const longText = "A".repeat(200);
    const env = updateToEnvelope(makeUpdate({ message: makeMessage({ text: longText }) }));
    expect(env?.preview).toHaveLength(100);
    expect(env?.preview).toBe("A".repeat(100));
  });

  test("sender name fallback: first+last -> username -> id", () => {
    // first+last
    const env1 = updateToEnvelope(
      makeUpdate({
        message: makeMessage({ from: { id: 1, first_name: "Bob", last_name: "Jones" } }),
      }),
    );
    expect(env1?.from?.name).toBe("Bob Jones");

    // username fallback
    const env2 = updateToEnvelope(
      makeUpdate({
        message: makeMessage({ from: { id: 2, username: "bobjones" } }),
      }),
    );
    expect(env2?.from?.name).toBe("bobjones");

    // id fallback
    const env3 = updateToEnvelope(
      makeUpdate({
        message: makeMessage({ from: { id: 3 } }),
      }),
    );
    expect(env3?.from?.name).toBe("3");
  });

  test("chat name fallback: title -> first+last -> username -> id", () => {
    // title
    const env1 = updateToEnvelope(
      makeUpdate({
        message: makeMessage({
          chat: { id: 10, type: "group", title: "My Group" },
        }),
      }),
    );
    expect(env1?.to[0]?.name).toBe("My Group");

    // first+last
    const env2 = updateToEnvelope(
      makeUpdate({
        message: makeMessage({
          chat: { id: 11, type: "private", first_name: "Jane", last_name: "Doe" },
        }),
      }),
    );
    expect(env2?.to[0]?.name).toBe("Jane Doe");

    // username
    const env3 = updateToEnvelope(
      makeUpdate({
        message: makeMessage({
          chat: { id: 12, type: "private", username: "janedoe" },
        }),
      }),
    );
    expect(env3?.to[0]?.name).toBe("janedoe");

    // id
    const env4 = updateToEnvelope(
      makeUpdate({
        message: makeMessage({
          chat: { id: 13, type: "private" },
        }),
      }),
    );
    expect(env4?.to[0]?.name).toBe("13");
  });

  test("date converted from unix epoch seconds to ISO string", () => {
    const env = updateToEnvelope(makeUpdate({ message: makeMessage({ date: 0 }) }));
    expect(env?.date).toBe("1970-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// updateToFull
// ---------------------------------------------------------------------------

describe("updateToFull", () => {
  test("returns MessageFull with body, bodyFormat='text', direction='in', empty attachments array", () => {
    const full = updateToFull(makeUpdate());
    expect(full).not.toBeNull();
    expect(full?.body).toBe("Hello world");
    expect(full?.bodyFormat).toBe("text");
    expect(full?.direction).toBe("in");
    expect(full?.attachments).toEqual([]);
  });

  test("caption used as body when text is absent", () => {
    const full = updateToFull(
      makeUpdate({
        message: makeMessage({ text: undefined, caption: "Photo caption" }),
      }),
    );
    expect(full).not.toBeNull();
    expect(full?.body).toBe("Photo caption");
  });
});
