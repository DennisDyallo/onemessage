import { describe, expect, test } from "bun:test";
import {
  type BeeperChat,
  type BeeperMessage,
  beeperMessageToFull,
  isFacebookAccount,
  messengerMessageId,
  resolveMessengerSettings,
} from "../../providers/messenger.ts";

const baseMessage: BeeperMessage = {
  id: "message-1",
  chatID: "chat-1",
  accountID: "account-fixture",
  senderID: "user-1",
  senderName: "Alice",
  timestamp: "2026-07-20T10:00:00.000Z",
  sortKey: "100",
  text: "hello",
};

const directChat: BeeperChat = {
  id: "chat-1",
  accountID: "account-fixture",
  title: "Alice",
  type: "single",
};

describe("Messenger message transformation", () => {
  test("maps incoming direct messages", () => {
    const result = beeperMessageToFull({ ...baseMessage, isUnread: true }, directChat);
    expect(result).toMatchObject({
      provider: "messenger",
      account: "account-fixture",
      direction: "in",
      unread: true,
      isGroup: false,
      body: "hello",
      preview: "hello",
      from: { name: "Alice", address: "user-1" },
      to: [{ name: "Alice", address: "chat-1" }],
    });
  });

  test("maps outgoing group messages", () => {
    const result = beeperMessageToFull(
      { ...baseMessage, isSender: true, isUnread: undefined },
      { ...directChat, title: "Project Team", type: "group" },
    );
    expect(result?.direction).toBe("out");
    expect(result?.unread).toBe(false);
    expect(result?.isGroup).toBe(true);
    expect(result?.groupName).toBe("Project Team");
  });

  test("truncates previews to 100 characters", () => {
    const result = beeperMessageToFull({ ...baseMessage, text: "x".repeat(101) }, directChat);
    expect(result?.preview).toBe("x".repeat(100));
    expect(result?.body).toBe("x".repeat(101));
  });

  test("maps attachment metadata and gives media-only messages readable previews", () => {
    const result = beeperMessageToFull(
      {
        ...baseMessage,
        text: "",
        attachments: [{ fileName: "photo.jpg", mimeType: "image/jpeg", fileSize: 1234 }],
      },
      directChat,
    );
    expect(result?.preview).toBe("[Photo]");
    expect(result?.hasAttachments).toBe(true);
    expect(result?.attachments).toEqual([
      { filename: "photo.jpg", contentType: "image/jpeg", size: 1234 },
    ]);
  });

  test("uses message type previews when media metadata is omitted", () => {
    const result = beeperMessageToFull(
      { ...baseMessage, text: undefined, type: "STICKER" },
      directChat,
    );
    expect(result?.preview).toBe("[Sticker]");
  });

  test("reads participants and unread state from the live chat shape", () => {
    const result = beeperMessageToFull(
      { ...baseMessage, senderName: undefined, sortKey: "101", isUnread: undefined },
      {
        ...directChat,
        unreadCount: 1,
        lastReadMessageSortKey: "100",
        participants: { items: [{ id: "user-1", fullName: "Alice Participant" }] },
      },
    );
    expect(result?.from?.name).toBe("Alice Participant");
    expect(result?.unread).toBe(true);
  });

  test("filters deleted, hidden, and reaction messages", () => {
    expect(beeperMessageToFull({ ...baseMessage, isDeleted: true }, directChat)).toBeNull();
    expect(beeperMessageToFull({ ...baseMessage, isHidden: true }, directChat)).toBeNull();
    expect(beeperMessageToFull({ ...baseMessage, type: "m.reaction" }, directChat)).toBeNull();
  });

  test("uses stable collision-resistant IDs scoped by chat", () => {
    expect(messengerMessageId("a:b", "c")).not.toBe(messengerMessageId("a", "b:c"));
    expect(messengerMessageId("a:b", "c")).toBe("chat:a%3Ab:message:c");
  });

  test("falls back to chat and sender IDs when chat metadata is missing", () => {
    const result = beeperMessageToFull({ ...baseMessage, senderName: undefined });
    expect(result?.from).toEqual({ name: "user-1", address: "user-1" });
    expect(result?.to).toEqual([{ name: "chat-1", address: "chat-1" }]);
    expect(result?.isGroup).toBe(false);
  });

  test("recognizes Facebook network and bridge discovery hints", () => {
    expect(isFacebookAccount({ network: "FACEBOOK" })).toBe(true);
    expect(isFacebookAccount({ bridge: { type: "facebookgo" } })).toBe(true);
    expect(isFacebookAccount({ bridge: { type: "custom-facebook-bridge" } })).toBe(true);
    expect(isFacebookAccount({ network: "Instagram", bridge: { type: "instagram" } })).toBe(false);
  });

  test("settings require account and token and strip every trailing base URL slash", () => {
    expect(
      resolveMessengerSettings({
        accountId: " fixture-account ",
        accessToken: " fixture-token ",
        baseUrl: "http://127.0.0.1:23373///",
      }),
    ).toEqual({
      accountId: "fixture-account",
      accessToken: "fixture-token",
      baseUrl: "http://127.0.0.1:23373",
    });
    expect(resolveMessengerSettings({ accountId: "fixture-account", accessToken: "" })).toBeNull();
    expect(
      resolveMessengerSettings({
        accountId: "fixture-account",
        accessToken: "fixture-token",
        baseUrl: "http://example.com",
      }),
    ).toBeNull();
    expect(
      resolveMessengerSettings({
        accountId: "fixture-account",
        accessToken: "fixture-token",
        baseUrl: "http://127.attacker.example",
      }),
    ).toBeNull();
    expect(
      resolveMessengerSettings({
        accountId: "fixture-account",
        accessToken: "fixture-token",
        baseUrl: "http://[::1]:23373",
      })?.baseUrl,
    ).toBe("http://[::1]:23373");
  });
});
