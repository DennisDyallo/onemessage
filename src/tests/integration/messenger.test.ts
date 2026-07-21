import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchMessengerMessages,
  type MessengerSettings,
  messengerMessageId,
  messengerProvider,
} from "../../providers/messenger.ts";
import {
  closeDb,
  getCachedMessage,
  getCursor,
  isFresh,
  recordFetch,
  setCursor,
  upsertFullMessages,
} from "../../store.ts";

const originalConfigDir = process.env.ONEMESSAGE_CONFIG_DIR;
let configDir = "";
const servers: Bun.Server<unknown>[] = [];

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "onemessage-messenger-test-"));
  process.env.ONEMESSAGE_CONFIG_DIR = configDir;
  closeDb();
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

afterAll(() => {
  closeDb();
  if (originalConfigDir === undefined) delete process.env.ONEMESSAGE_CONFIG_DIR;
  else process.env.ONEMESSAGE_CONFIG_DIR = originalConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

function fakeServer(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server;
}

function settings(server: Bun.Server<unknown>, accountId: string): MessengerSettings {
  return {
    accountId,
    accessToken: `fixture-token-${accountId}`,
    baseUrl: `http://127.0.0.1:${server.port}`,
  };
}

describe("Messenger Beeper Client API integration", () => {
  test("poll sends bearer access, scopes requests, discards other accounts, and caches messages", async () => {
    const accountId = "fixture-account-poll";
    let requestUrl: URL | undefined;
    let authorization = "";
    const server = fakeServer((request) => {
      requestUrl = new URL(request.url);
      authorization = request.headers.get("authorization") ?? "";
      return Response.json({
        items: [
          {
            id: "fixture-message-kept",
            chatID: "fixture-chat-kept",
            accountID: accountId,
            senderID: "fixture-sender",
            senderName: "Fixture Sender",
            timestamp: "2026-07-20T12:00:00.000Z",
            sortKey: "100",
            text: "cached body",
            isUnread: true,
          },
          {
            id: "fixture-message-other",
            chatID: "fixture-chat-other",
            accountID: "fixture-account-other",
            senderID: "other-sender",
            timestamp: "2026-07-20T12:01:00.000Z",
            sortKey: "101",
            text: "must not cache",
          },
        ],
        chats: {
          "fixture-chat-kept": {
            id: "fixture-chat-kept",
            accountID: accountId,
            title: "Fixture Chat",
            type: "single",
          },
          "fixture-chat-other": {
            id: "fixture-chat-other",
            accountID: "fixture-account-other",
            title: "Other Chat",
            type: "single",
          },
        },
        hasMore: false,
      });
    });

    await fetchMessengerMessages(settings(server, accountId));

    expect(authorization).toBe(`Bearer fixture-token-${accountId}`);
    expect(requestUrl?.pathname).toBe("/v1/messages/search");
    expect(requestUrl?.searchParams.get("accountIDs")).toBe(accountId);
    expect(requestUrl?.searchParams.get("limit")).toBe("20");
    expect(requestUrl?.searchParams.get("excludeLowPriority")).toBe("false");
    const cached = getCachedMessage(
      "messenger",
      messengerMessageId("fixture-chat-kept", "fixture-message-kept"),
    );
    expect(cached?.body).toBe("cached body");
    expect(cached?.account).toBe(accountId);
    expect(
      getCachedMessage(
        "messenger",
        messengerMessageId("fixture-chat-other", "fixture-message-other"),
      ),
    ).toBeNull();
    expect(getCursor("messenger", accountId, "messages.timestamp")).toBe(
      "2026-07-20T12:00:00.000Z",
    );
    expect(isFresh("messenger", 60_000, accountId)).toBe(true);
  });

  test("a successful empty poll records freshness", async () => {
    const accountId = "fixture-account-empty";
    const server = fakeServer(() =>
      Response.json({ items: [], chats: {}, hasMore: false, oldestCursor: null }),
    );
    await fetchMessengerMessages(settings(server, accountId));
    expect(isFresh("messenger", 60_000, accountId)).toBe(true);
  });

  test("incremental polls overlap the watermark and paginate older result pages", async () => {
    const accountId = "fixture-account-incremental";
    setCursor("messenger", accountId, "messages.timestamp", "2026-07-20T10:00:00.000Z");
    const requests: URL[] = [];
    const server = fakeServer((request) => {
      const url = new URL(request.url);
      requests.push(url);
      const secondPage = url.searchParams.has("cursor");
      return Response.json({
        items: [
          {
            id: secondPage ? "fixture-page-2" : "fixture-page-1",
            chatID: "fixture-chat-incremental",
            accountID: accountId,
            senderID: "fixture-sender",
            timestamp: secondPage ? "2026-07-20T10:02:00.000Z" : "2026-07-20T10:03:00.000Z",
            sortKey: secondPage ? "102" : "103",
            text: secondPage ? "second page" : "first page",
          },
        ],
        chats: {
          "fixture-chat-incremental": {
            id: "fixture-chat-incremental",
            accountID: accountId,
            title: "Incremental Chat",
            type: "single",
          },
        },
        hasMore: !secondPage,
        oldestCursor: secondPage ? undefined : "fixture-oldest-cursor",
      });
    });

    await fetchMessengerMessages(settings(server, accountId));

    expect(requests).toHaveLength(2);
    expect(requests[0]?.searchParams.get("dateAfter")).toBe("2026-07-20T09:59:59.000Z");
    expect(requests[1]?.searchParams.get("cursor")).toBe("fixture-oldest-cursor");
    expect(requests[1]?.searchParams.get("direction")).toBe("before");
    expect(
      getCachedMessage(
        "messenger",
        messengerMessageId("fixture-chat-incremental", "fixture-page-2"),
      )?.body,
    ).toBe("second page");
    expect(getCursor("messenger", accountId, "messages.timestamp")).toBe(
      "2026-07-20T10:03:00.000Z",
    );
  });

  test("a failed poll records neither freshness nor watermark and redacts tokens", async () => {
    const accountId = "fixture-account-failed";
    const token = `fixture-token-${accountId}`;
    const server = fakeServer(() => new Response(`failure ${token}`, { status: 503 }));
    let error = "";
    try {
      await fetchMessengerMessages(settings(server, accountId));
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    expect(error).toContain("Messenger GET /v1/messages/search");
    expect(error).toContain("503");
    expect(error).toContain("failure [redacted]");
    expect(error).not.toContain(token);
    expect(isFresh("messenger", 60_000, accountId)).toBe(false);
    expect(getCursor("messenger", accountId, "messages.timestamp")).toBeNull();
  });

  test("send posts once, resolves the pending ID, and caches the outgoing body", async () => {
    const accountId = "fixture-account-send";
    const chatId = "fixture/chat send";
    let postCount = 0;
    let postedBody: unknown;
    const server = fakeServer(async (request) => {
      if (request.method === "POST") {
        postCount++;
        postedBody = await request.json();
        return Response.json({ chatID: chatId, pendingMessageID: "pending-fixture" });
      }
      if (new URL(request.url).pathname === `/v1/chats/${encodeURIComponent(chatId)}`) {
        return Response.json({ id: chatId, accountID: accountId, title: "Fixture Chat" });
      }
      return Response.json({
        id: "final-fixture",
        chatID: chatId,
        accountID: accountId,
        senderID: accountId,
        timestamp: "2026-07-20T13:00:00.000Z",
        sortKey: "100",
        text: "sent body",
        isSender: true,
      });
    });

    const result = await messengerProvider.send(chatId, "sent body", {
      providerFlags: { ...settings(server, accountId) },
    });
    expect(result.ok).toBe(true);
    expect(postCount).toBe(1);
    expect(postedBody).toEqual({ text: "sent body" });
    expect(result.messageId).toBe(messengerMessageId(chatId, "final-fixture"));
    const cached = getCachedMessage("messenger", result.messageId ?? "");
    expect(cached?.body).toBe("sent body");
    expect(cached?.to).toEqual([{ name: "Fixture Chat", address: chatId }]);
  });

  test("page JSON scopes cached rows to the configured Messenger account", () => {
    const accountId = "fixture-account-page-current";
    const staleAccountId = "fixture-account-page-stale";
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        messenger: {
          accountId,
          accessToken: "fixture-token-page",
          baseUrl: "http://127.0.0.1:23373",
        },
      }),
      "utf-8",
    );
    upsertFullMessages([
      {
        id: "fixture-page-current",
        provider: "messenger",
        account: accountId,
        from: { name: "Current Sender", address: "current-sender" },
        to: [{ name: "Current Chat", address: "current-chat" }],
        preview: "current",
        body: "current",
        bodyFormat: "text",
        date: "2026-07-20T14:10:00.000Z",
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in",
      },
      {
        id: "fixture-page-stale",
        provider: "messenger",
        account: staleAccountId,
        from: { name: "Stale Sender", address: "stale-sender" },
        to: [{ name: "Stale Chat", address: "stale-chat" }],
        preview: "stale",
        body: "stale",
        bodyFormat: "text",
        date: "2026-07-20T14:11:00.000Z",
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in",
      },
    ]);
    recordFetch("messenger", accountId);

    const result = Bun.spawnSync(
      ["bun", "src/cli.ts", "inbox", "messenger", "--page-json", "--limit", "10"],
      {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).toBe(0);
    const page = JSON.parse(result.stdout.toString());
    const ids = page.messages.map((message: { id: string }) => message.id);
    expect(ids).toContain("fixture-page-current");
    expect(ids).not.toContain("fixture-page-stale");
  });

  test("page JSON rejects an explicit account conflicting with configured Messenger", () => {
    const accountId = "fixture-account-conflict-current";
    const staleAccountId = "fixture-account-conflict-stale";
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        messenger: {
          accountId,
          accessToken: "fixture-token-conflict",
          baseUrl: "http://127.0.0.1:23373",
        },
      }),
      "utf-8",
    );
    upsertFullMessages([
      {
        id: "fixture-page-conflict-stale-message",
        provider: "messenger",
        account: staleAccountId,
        from: { name: "Stale Sender", address: "stale-sender" },
        to: [{ name: "Stale Chat", address: "stale-chat" }],
        preview: "stale",
        body: "stale",
        bodyFormat: "text",
        date: "2026-07-20T14:12:00.000Z",
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in",
      },
    ]);
    recordFetch("messenger", accountId);

    const result = Bun.spawnSync(
      [
        process.execPath,
        "src/cli.ts",
        "inbox",
        "messenger",
        "--page-json",
        "--account",
        staleAccountId,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("--account conflicts with the configured account");
    expect(result.stdout.toString()).not.toContain("fixture-page-conflict-stale-message");
  });

  test("page JSON rejects unconfigured Messenger before reading stale cache", () => {
    const staleAccountId = "fixture-account-unconfigured-stale";
    writeFileSync(join(configDir, "config.json"), JSON.stringify({}), "utf-8");
    upsertFullMessages([
      {
        id: "fixture-page-unconfigured-stale-message",
        provider: "messenger",
        account: staleAccountId,
        from: { name: "Stale Sender", address: "stale-sender" },
        to: [{ name: "Stale Chat", address: "stale-chat" }],
        preview: "stale",
        body: "stale",
        bodyFormat: "text",
        date: "2026-07-20T14:13:00.000Z",
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in",
      },
    ]);

    const result = Bun.spawnSync(
      [
        process.execPath,
        "src/cli.ts",
        "inbox",
        "messenger",
        "--page-json",
        "--account",
        staleAccountId,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Cannot resolve the configured account");
    expect(result.stdout.toString()).not.toContain("fixture-page-unconfigured-stale-message");
  });

  test("send rejects chats outside the configured Facebook account", async () => {
    const accountId = "fixture-account-send-scope";
    let postCount = 0;
    const server = fakeServer((request) => {
      if (request.method === "POST") postCount++;
      return Response.json({
        id: "fixture-chat-other-account",
        accountID: "fixture-account-other",
        title: "Other Account Chat",
      });
    });

    const result = await messengerProvider.send("fixture-chat-other-account", "blocked", {
      providerFlags: { ...settings(server, accountId) },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not belong to the configured Facebook account");
    expect(postCount).toBe(0);
  });

  test("send reads text bodies from files", async () => {
    const accountId = "fixture-account-send-file";
    const chatId = "fixture-chat-send-file";
    const bodyPath = join(configDir, "messenger-send-body.txt");
    writeFileSync(bodyPath, "body from file", "utf-8");
    let postedBody: unknown;
    const server = fakeServer(async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") {
        postedBody = await request.json();
        return Response.json({ chatID: chatId, pendingMessageID: "pending-file" });
      }
      if (path === `/v1/chats/${chatId}`) {
        return Response.json({ id: chatId, accountID: accountId, title: "Fixture Chat" });
      }
      return Response.json({
        id: "final-file",
        chatID: chatId,
        accountID: accountId,
        senderID: accountId,
        timestamp: "2026-07-20T13:10:00.000Z",
        sortKey: "110",
        text: "body from file",
        isSender: true,
      });
    });

    const result = await messengerProvider.send(chatId, "", {
      file: bodyPath,
      providerFlags: { ...settings(server, accountId) },
    });
    expect(result.ok).toBe(true);
    expect(postedBody).toEqual({ text: "body from file" });
    expect(getCachedMessage("messenger", result.messageId ?? "")?.body).toBe("body from file");
  });

  test("send never retries POST when pending-message resolution fails", async () => {
    const accountId = "fixture-account-ambiguous";
    let postCount = 0;
    const server = fakeServer((request) => {
      if (request.method === "POST") {
        postCount++;
        return Response.json({
          chatID: "fixture-chat-ambiguous",
          pendingMessageID: "pending-only",
        });
      }
      if (new URL(request.url).pathname === "/v1/chats/fixture-chat-ambiguous") {
        return Response.json({
          id: "fixture-chat-ambiguous",
          accountID: accountId,
          title: "Fixture Chat",
        });
      }
      return new Response("not ready", { status: 503 });
    });

    const result = await messengerProvider.send("fixture-chat-ambiguous", "once", {
      providerFlags: { ...settings(server, accountId) },
    });
    expect(result.ok).toBe(true);
    expect(postCount).toBe(1);
    expect(result.messageId).toBe(messengerMessageId("fixture-chat-ambiguous", "pending-only"));
  });

  test("reply routes incoming messages through their Beeper chat ID", async () => {
    const accountId = "fixture-account-reply";
    const chatId = "fixture-chat-reply";
    const originalId = messengerMessageId(chatId, "fixture-incoming");
    upsertFullMessages([
      {
        id: originalId,
        provider: "messenger",
        account: accountId,
        from: { name: "Sender", address: "fixture-sender-id" },
        to: [{ name: "Fixture Chat", address: chatId }],
        preview: "incoming",
        body: "incoming",
        bodyFormat: "text",
        date: "2026-07-20T13:30:00.000Z",
        unread: true,
        hasAttachments: false,
        attachments: [],
        direction: "in",
      },
    ]);
    let postedPath = "";
    const server = fakeServer((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") {
        postedPath = path;
        return Response.json({ chatID: chatId, pendingMessageID: "pending-reply" });
      }
      if (path === `/v1/chats/${encodeURIComponent(chatId)}`) {
        return Response.json({ id: chatId, accountID: accountId, title: "Fixture Chat" });
      }
      return Response.json({
        id: "final-reply",
        chatID: chatId,
        accountID: accountId,
        senderID: accountId,
        timestamp: "2026-07-20T13:31:00.000Z",
        sortKey: "131",
        text: "reply body",
        isSender: true,
      });
    });

    const result = await messengerProvider.reply?.(originalId, "reply body", {
      providerFlags: { ...settings(server, accountId) },
    });
    expect(result?.ok).toBe(true);
    expect(postedPath).toBe(`/v1/chats/${encodeURIComponent(chatId)}/messages`);
  });

  test("read rejects cached messages from another configured account", async () => {
    const messageId = "fixture-read-other-account";
    upsertFullMessages([
      {
        id: messageId,
        provider: "messenger",
        account: "fixture-account-read-other",
        from: { name: "Other", address: "other" },
        to: [{ name: "Chat", address: "chat" }],
        preview: "other account",
        body: "other account",
        bodyFormat: "text",
        date: "2026-07-20T13:40:00.000Z",
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in",
      },
    ]);
    const result = await messengerProvider.read(messageId, {
      providerFlags: {
        accountId: "fixture-account-read-current",
        accessToken: "fixture-token-read",
        baseUrl: "http://127.0.0.1:23373",
      },
    });
    expect(result).toBeNull();
  });

  test("deleted messages are removed from the local cache", async () => {
    const accountId = "fixture-account-delete";
    const chatId = "fixture-chat-delete";
    const messageId = messengerMessageId(chatId, "fixture-deleted");
    upsertFullMessages([
      {
        id: messageId,
        provider: "messenger",
        account: accountId,
        from: { name: "Sender", address: "sender" },
        to: [{ name: "Chat", address: chatId }],
        preview: "deleted later",
        body: "deleted later",
        bodyFormat: "text",
        date: "2026-07-20T13:50:00.000Z",
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in",
      },
    ]);
    const server = fakeServer(() =>
      Response.json({
        items: [
          {
            id: "fixture-deleted",
            chatID: chatId,
            accountID: accountId,
            senderID: "sender",
            timestamp: "2026-07-20T13:50:00.000Z",
            sortKey: "150",
            isDeleted: true,
          },
        ],
        chats: {},
        hasMore: false,
      }),
    );

    await fetchMessengerMessages(settings(server, accountId));
    expect(getCachedMessage("messenger", messageId)).toBeNull();
  });

  test("cached search remains scoped to the configured Beeper account", async () => {
    const accountId = "fixture-account-search";
    upsertFullMessages([
      {
        id: "fixture-search-own",
        provider: "messenger",
        account: accountId,
        from: { name: "Own", address: "own" },
        to: [{ name: "Chat", address: "chat" }],
        preview: "scope marker",
        body: "scope marker",
        bodyFormat: "text",
        date: "2026-07-20T14:00:00.000Z",
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in",
      },
      {
        id: "fixture-search-other",
        provider: "messenger",
        account: "fixture-account-search-other",
        from: { name: "Other", address: "other" },
        to: [{ name: "Chat", address: "chat" }],
        preview: "scope marker",
        body: "scope marker",
        bodyFormat: "text",
        date: "2026-07-20T14:01:00.000Z",
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in",
      },
    ]);

    const results = await messengerProvider.search?.("scope marker", {
      providerFlags: {
        accountId,
        accessToken: "fixture-token-search",
        baseUrl: "http://127.0.0.1:23373",
      },
    });
    expect(results?.map((message) => message.id)).toEqual(["fixture-search-own"]);
  });
});
