import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { getConfigPath, loadConfig, saveConfig } from "../../config.ts";
import { SmsAdapter } from "../../daemons/sms.ts";
import { beeperMessageId, pendingBeeperMessageId } from "../../providers/beeper-client.ts";
import {
  type BeeperSmsSettings,
  beeperSmsMessageToFull,
  fetchBeeperSmsMessages,
  isGoogleMessagesAccount,
  resolveSmsBackend,
  smsProvider,
} from "../../providers/sms.ts";
import { resolveKdeSmsSettings } from "../../providers/sms-kdeconnect.ts";
import * as store from "../../store.ts";
import type { MessageFull } from "../../types.ts";

const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function fakeServer(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server;
}

function settings(server: Bun.Server<unknown>, accountId: string): BeeperSmsSettings {
  return {
    backend: "beeper",
    accountId,
    accessToken: `fixture-token-${accountId}`,
    baseUrl: `http://127.0.0.1:${server.port}`,
  };
}

function providerFlags(server: Bun.Server<unknown>, accountId: string) {
  return {
    backend: "beeper",
    accountId,
    accessToken: `fixture-token-${accountId}`,
    baseUrl: `http://127.0.0.1:${server.port}`,
  };
}

function cachedSms(id: string, account: string, chatId: string, body: string): MessageFull {
  return {
    id,
    provider: "sms",
    account,
    from: { name: "Fixture Sender", address: "+15555550100" },
    to: [{ name: "Fixture Chat", address: chatId }],
    preview: body,
    body,
    bodyFormat: "text",
    date: "2026-07-22T12:00:00.000Z",
    unread: false,
    hasAttachments: false,
    attachments: [],
    direction: "in",
  };
}

describe("SMS Beeper mapping and discovery", () => {
  test("recognizes Google Messages network and bridge indicators", () => {
    expect(isGoogleMessagesAccount({ network: "gmessages" })).toBe(true);
    expect(isGoogleMessagesAccount({ network: "Google Messages" })).toBe(true);
    expect(isGoogleMessagesAccount({ bridge: { type: "google_messages" } })).toBe(true);
    expect(isGoogleMessagesAccount({ network: "facebook" })).toBe(false);
  });

  test("maps direct and group messages under the public sms namespace", () => {
    const direct = beeperSmsMessageToFull(
      {
        id: "direct-message",
        chatID: "global-direct-chat",
        accountID: "gmessages-fixture",
        senderID: "sender-id",
        timestamp: "2026-07-22T10:00:00.000Z",
        sortKey: "101",
        text: "hello",
        isUnread: true,
      },
      {
        id: "global-direct-chat",
        localChatID: "local-direct-chat",
        accountID: "gmessages-fixture",
        type: "single",
        participants: [{ id: "sender-id", phoneNumber: "+15555550100", name: "Alice" }],
      },
    );
    expect(direct).toMatchObject({
      id: beeperMessageId("global-direct-chat", "direct-message"),
      provider: "sms",
      account: "gmessages-fixture",
      isGroup: false,
      direction: "in",
      from: { name: "Alice", address: "+15555550100" },
      to: [{ name: "Alice", address: "global-direct-chat" }],
    });

    const group = beeperSmsMessageToFull(
      {
        id: "group-message",
        chatID: "global-group-chat",
        accountID: "gmessages-fixture",
        senderID: "bob-id",
        timestamp: "2026-07-22T10:01:00.000Z",
        sortKey: "102",
        text: "group hello",
      },
      {
        id: "global-group-chat",
        accountID: "gmessages-fixture",
        type: "group",
        participants: [
          { id: "alice-id", name: "Alice" },
          { id: "bob-id", name: "Bob" },
        ],
      },
    );
    expect(group).toMatchObject({
      provider: "sms",
      isGroup: true,
      groupName: "Alice, Bob",
      to: [{ name: "Alice, Bob", address: "global-group-chat" }],
    });
  });

  test("filters deleted, hidden, reactions, and invalid timestamps", () => {
    const message = {
      id: "filtered",
      chatID: "chat",
      accountID: "account",
      senderID: "sender",
      timestamp: "2026-07-22T10:00:00.000Z",
      sortKey: "1",
    };
    expect(beeperSmsMessageToFull({ ...message, isDeleted: true })).toBeNull();
    expect(beeperSmsMessageToFull({ ...message, isHidden: true })).toBeNull();
    expect(beeperSmsMessageToFull({ ...message, type: "m.reaction" })).toBeNull();
    expect(beeperSmsMessageToFull({ ...message, timestamp: "invalid" })).toBeNull();
  });
});

describe("SMS Beeper polling", () => {
  test("paginates incrementally, scopes accounts, deletes tombstones, and advances freshness", async () => {
    const accountId = `gmessages-poll-${Date.now()}`;
    const chatId = "global-poll-chat";
    const deletedId = beeperMessageId(chatId, "deleted-message");
    store.upsertFullMessages([cachedSms(deletedId, accountId, chatId, "delete me")]);
    store.setCursor("sms", accountId, "messages.timestamp", "2026-07-22T09:00:00.000Z");
    const requests: URL[] = [];
    const server = fakeServer((request) => {
      const url = new URL(request.url);
      requests.push(url);
      const secondPage = url.searchParams.has("cursor");
      return Response.json({
        items: secondPage
          ? [
              {
                id: "kept-message",
                chatID: chatId,
                accountID: accountId,
                senderID: "sender",
                timestamp: "2026-07-22T09:02:00.000Z",
                sortKey: "102",
                text: "kept body",
              },
              {
                id: "other-account",
                chatID: "other-chat",
                accountID: "other-gmessages",
                senderID: "other",
                timestamp: "2026-07-22T09:03:00.000Z",
                sortKey: "103",
                text: "must not cache",
              },
            ]
          : [
              {
                id: "deleted-message",
                chatID: chatId,
                accountID: accountId,
                senderID: "sender",
                timestamp: "2026-07-22T09:01:00.000Z",
                sortKey: "101",
                isDeleted: true,
              },
            ],
        chats: {
          [chatId]: { id: chatId, accountID: accountId, title: "Poll Chat", type: "single" },
        },
        hasMore: !secondPage,
        oldestCursor: secondPage ? undefined : "older-page",
      });
    });

    await fetchBeeperSmsMessages(settings(server, accountId));

    expect(requests).toHaveLength(2);
    expect(requests[0]?.searchParams.get("accountIDs")).toBe(accountId);
    expect(requests[0]?.searchParams.get("dateAfter")).toBe("2026-07-22T08:59:59.000Z");
    expect(requests[1]?.searchParams.get("cursor")).toBe("older-page");
    expect(store.getCachedMessage("sms", deletedId)).toBeNull();
    expect(store.getCachedMessage("sms", beeperMessageId(chatId, "kept-message"))?.account).toBe(
      accountId,
    );
    expect(
      store.getCachedMessage("sms", beeperMessageId("other-chat", "other-account")),
    ).toBeNull();
    expect(store.getCursor("sms", accountId, "messages.timestamp")).toBe(
      "2026-07-22T09:02:00.000Z",
    );
    expect(store.isFresh("sms", 60_000, accountId)).toBe(true);
  });

  test("failed polls advance neither freshness nor watermark", async () => {
    const accountId = `gmessages-failed-${Date.now()}`;
    const server = fakeServer(() => new Response("failed", { status: 503 }));
    expect(fetchBeeperSmsMessages(settings(server, accountId))).rejects.toThrow(
      "SMS GET /v1/messages/search",
    );
    expect(store.getCursor("sms", accountId, "messages.timestamp")).toBeNull();
    expect(store.isFresh("sms", 60_000, accountId)).toBe(false);
  });

  test("reconciles an explicitly marked pending row through its exact Beeper pending ID", async () => {
    const accountId = `gmessages-reconcile-${Date.now()}`;
    const chatId = "global-reconcile-chat";
    const pendingId = pendingBeeperMessageId(chatId, "pending-reconcile");
    const canonicalId = beeperMessageId(chatId, "canonical-reconcile");
    store.upsertFullMessages([cachedSms(pendingId, accountId, chatId, "same body")]);
    const server = fakeServer((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/messages/search") {
        return Response.json({
          items: [],
          chats: {
            [chatId]: { id: chatId, accountID: accountId, title: "Reconcile Chat", type: "single" },
          },
          hasMore: false,
        });
      }
      if (path.endsWith("/messages/pending-reconcile")) {
        return Response.json({
          id: "canonical-reconcile",
          chatID: chatId,
          accountID: accountId,
          senderID: accountId,
          timestamp: "2026-07-22T11:30:00.000Z",
          sortKey: "230",
          text: "same body",
          isSender: true,
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    await fetchBeeperSmsMessages(settings(server, accountId));

    expect(store.getCachedMessage("sms", pendingId)).toBeNull();
    expect(store.getCachedMessage("sms", canonicalId)?.body).toBe("same body");
  });

  test("does not text-match pending rows against unrelated repeated messages", async () => {
    const accountId = `gmessages-repeat-safe-${Date.now()}`;
    const chatId = "global-repeat-safe-chat";
    const pendingId = pendingBeeperMessageId(chatId, "pending-repeat-safe");
    const canonicalId = beeperMessageId(chatId, "canonical-repeat-safe");
    store.upsertFullMessages([cachedSms(pendingId, accountId, chatId, "repeated text")]);
    const server = fakeServer((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/messages/search") {
        return Response.json({
          items: [
            {
              id: "canonical-repeat-safe",
              chatID: chatId,
              accountID: accountId,
              senderID: accountId,
              timestamp: "2026-07-22T11:31:00.000Z",
              sortKey: "231",
              text: "repeated text",
              isSender: true,
            },
          ],
          chats: {
            [chatId]: { id: chatId, accountID: accountId, title: "Repeat Chat", type: "single" },
          },
          hasMore: false,
        });
      }
      return new Response("pending not resolved", { status: 503 });
    });

    await fetchBeeperSmsMessages(settings(server, accountId));

    expect(store.getCachedMessage("sms", pendingId)?.body).toBe("repeated text");
    expect(store.getCachedMessage("sms", canonicalId)?.body).toBe("repeated text");
  });
});

describe("SMS Beeper delivery", () => {
  test("starts direct chats by normalized phone, sends once, and resolves pending IDs", async () => {
    const accountId = `gmessages-send-${Date.now()}`;
    const chatId = "global-direct-send-chat";
    let startBody: unknown;
    let sendBody: unknown;
    let sendPosts = 0;
    const server = fakeServer(async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/v1/chats/start") {
        startBody = await request.json();
        return Response.json({ chatID: chatId, status: "created" });
      }
      if (request.method === "POST" && path === `/v1/chats/${chatId}/messages`) {
        sendPosts++;
        sendBody = await request.json();
        return Response.json({ chatID: chatId, pendingMessageID: "pending-send" });
      }
      if (path === `/v1/chats/${chatId}`) {
        return Response.json({
          id: chatId,
          localChatID: "local-chat-must-not-be-used",
          accountID: accountId,
          title: "Alice",
          type: "single",
        });
      }
      return Response.json({
        id: "final-send",
        chatID: chatId,
        accountID: accountId,
        senderID: accountId,
        timestamp: "2026-07-22T11:00:00.000Z",
        sortKey: "200",
        text: "hello",
        isSender: true,
      });
    });

    const result = await smsProvider.send("0046 72-123 45 67", "hello", {
      providerFlags: providerFlags(server, accountId),
    });

    expect(result.ok).toBe(true);
    expect(startBody).toEqual({ accountID: accountId, user: { phoneNumber: "+46721234567" } });
    expect(sendPosts).toBe(1);
    expect(sendBody).toEqual({ text: "hello" });
    expect(result.messageId).toBe(beeperMessageId(chatId, "final-send"));
    expect(store.getCachedMessage("sms", result.messageId ?? "")?.to[0]?.address).toBe(chatId);
  });

  test("uses canonical group chat IDs without starting a direct chat", async () => {
    const accountId = `gmessages-group-${Date.now()}`;
    const chatId = "global-group-send-chat";
    let startPosts = 0;
    let sendPosts = 0;
    const server = fakeServer((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/v1/chats/start") startPosts++;
      if (request.method === "POST") {
        sendPosts++;
        return Response.json({ chatID: chatId, pendingMessageID: "pending-group" });
      }
      if (path === `/v1/chats/${chatId}`) {
        return Response.json({ id: chatId, accountID: accountId, title: "Family", type: "group" });
      }
      return new Response("pending", { status: 503 });
    });
    const result = await smsProvider.send(chatId, "group hello", {
      providerFlags: providerFlags(server, accountId),
    });
    expect(result.ok).toBe(true);
    expect(startPosts).toBe(0);
    expect(sendPosts).toBe(1);
    expect(result.messageId).toBe(pendingBeeperMessageId(chatId, "pending-group"));
  });

  test("rejects attachments before any API request", async () => {
    const accountId = `gmessages-attachment-${Date.now()}`;
    let requests = 0;
    const server = fakeServer(() => {
      requests++;
      return Response.json({});
    });
    const result = await smsProvider.send("+15555550100", "attachment", {
      attachments: ["fixture.jpg"],
      providerFlags: providerFlags(server, accountId),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("attachment sending is not supported");
    expect(requests).toBe(0);
  });

  test("never retries a successful send when pending resolution fails", async () => {
    const accountId = `gmessages-pending-${Date.now()}`;
    const chatId = "global-pending-chat";
    let sendPosts = 0;
    const server = fakeServer((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") {
        sendPosts++;
        return Response.json({ chatID: chatId, pendingMessageID: "pending-only" });
      }
      if (path === `/v1/chats/${chatId}`) {
        return Response.json({ id: chatId, accountID: accountId, title: "Pending Chat" });
      }
      return new Response("not ready", { status: 503 });
    });
    const result = await smsProvider.send(chatId, "once", {
      providerFlags: providerFlags(server, accountId),
    });
    expect(result.ok).toBe(true);
    expect(sendPosts).toBe(1);
    expect(result.messageId).toBe(pendingBeeperMessageId(chatId, "pending-only"));
  });

  test("reads --file as the text body", async () => {
    const accountId = `gmessages-file-${Date.now()}`;
    const chatId = "global-file-chat";
    const bodyPath = `${getConfigPath()}.sms-body`;
    writeFileSync(bodyPath, "body from SMS file", "utf-8");
    let postedBody: unknown;
    const server = fakeServer(async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") {
        postedBody = await request.json();
        return Response.json({ chatID: chatId, pendingMessageID: "pending-file" });
      }
      if (path === `/v1/chats/${chatId}`) {
        return Response.json({ id: chatId, accountID: accountId, title: "File Chat" });
      }
      return new Response("pending", { status: 503 });
    });
    const result = await smsProvider.send(chatId, "", {
      file: bodyPath,
      providerFlags: providerFlags(server, accountId),
    });
    expect(result.ok).toBe(true);
    expect(postedBody).toEqual({ text: "body from SMS file" });
    expect(store.getCachedMessage("sms", result.messageId ?? "")?.body).toBe("body from SMS file");
  });

  test("treats a malformed 2xx send response as ambiguous success without retrying", async () => {
    const accountId = `gmessages-malformed-${Date.now()}`;
    const chatId = "global-malformed-chat";
    let sendPosts = 0;
    const server = fakeServer((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") {
        sendPosts++;
        return new Response("delivered but malformed", { status: 202 });
      }
      if (path === `/v1/chats/${chatId}`) {
        return Response.json({ id: chatId, accountID: accountId, title: "Malformed Chat" });
      }
      return new Response("unexpected", { status: 500 });
    });
    const result = await smsProvider.send(chatId, "send exactly once", {
      providerFlags: providerFlags(server, accountId),
    });
    expect(result.ok).toBe(true);
    expect(sendPosts).toBe(1);
    expect(result.messageId).toStartWith(`unknown:chat:${encodeURIComponent(chatId)}:message:`);
    expect(store.getCachedMessage("sms", result.messageId ?? "")?.body).toBe("send exactly once");
  });

  test("keeps non-2xx send responses as failures and never retries", async () => {
    const accountId = `gmessages-send-failure-${Date.now()}`;
    const chatId = "global-send-failure-chat";
    let sendPosts = 0;
    const server = fakeServer((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") {
        sendPosts++;
        return new Response("definite failure", { status: 503 });
      }
      if (path === `/v1/chats/${chatId}`) {
        return Response.json({ id: chatId, accountID: accountId, title: "Failure Chat" });
      }
      return new Response("unexpected", { status: 500 });
    });
    const result = await smsProvider.send(chatId, "do not retry", {
      providerFlags: providerFlags(server, accountId),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("503 definite failure");
    expect(sendPosts).toBe(1);
  });

  test("replies through the cached global chat ID", async () => {
    const accountId = `gmessages-reply-${Date.now()}`;
    const chatId = "global-reply-chat";
    const originalId = beeperMessageId(chatId, "incoming-reply");
    store.upsertFullMessages([cachedSms(originalId, accountId, chatId, "incoming")]);
    let postedPath = "";
    const server = fakeServer((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") {
        postedPath = path;
        return Response.json({ chatID: chatId, pendingMessageID: "pending-reply" });
      }
      if (path === `/v1/chats/${chatId}`) {
        return Response.json({ id: chatId, accountID: accountId, title: "Reply Chat" });
      }
      return new Response("pending", { status: 503 });
    });
    const result = await smsProvider.reply?.(originalId, "reply body", {
      providerFlags: providerFlags(server, accountId),
    });
    expect(result?.ok).toBe(true);
    expect(postedPath).toBe(`/v1/chats/${chatId}/messages`);
  });

  test("rejects chats from another account before posting a message", async () => {
    const accountId = `gmessages-scope-${Date.now()}`;
    let posts = 0;
    const server = fakeServer((request) => {
      if (request.method === "POST") posts++;
      return Response.json({ id: "foreign-chat", accountID: "different-account" });
    });
    const result = await smsProvider.send("foreign-chat", "blocked", {
      providerFlags: providerFlags(server, accountId),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not belong");
    expect(posts).toBe(0);
  });
});

describe("SMS account isolation and backend selection", () => {
  test("read and search expose only the configured Beeper account", async () => {
    const ownAccount = `gmessages-own-${Date.now()}`;
    const otherAccount = `${ownAccount}-other`;
    const ownId = `${ownAccount}-message`;
    const otherId = `${otherAccount}-message`;
    store.upsertFullMessages([
      cachedSms(ownId, ownAccount, "own-chat", "account isolation marker"),
      cachedSms(otherId, otherAccount, "other-chat", "account isolation marker"),
    ]);
    const flags = {
      backend: "beeper",
      accountId: ownAccount,
      accessToken: "fixture-token",
      baseUrl: "http://127.0.0.1:23373",
    };
    expect((await smsProvider.read(ownId, { providerFlags: flags }))?.id).toBe(ownId);
    expect(await smsProvider.read(otherId, { providerFlags: flags })).toBeNull();
    expect(
      (await smsProvider.search?.("account isolation marker", { providerFlags: flags }))?.map(
        (message) => message.id,
      ),
    ).toEqual([ownId]);
  });

  test("page JSON exposes only the selected Google Messages account", () => {
    const previous = structuredClone(loadConfig());
    const accountId = `gmessages-page-${Date.now()}`;
    const otherAccount = `${accountId}-other`;
    const ownId = `${accountId}-message`;
    const otherId = `${otherAccount}-message`;
    try {
      saveConfig({
        ...previous,
        beeper: { accessToken: "fixture-token", baseUrl: "http://127.0.0.1:23373" },
        sms: { backend: "beeper", accountId },
      });
      store.upsertFullMessages([
        cachedSms(ownId, accountId, "own-page-chat", "own page"),
        cachedSms(otherId, otherAccount, "other-page-chat", "other page"),
      ]);
      store.recordFetch("sms", accountId);
      const result = Bun.spawnSync(
        [process.execPath, "src/cli.ts", "inbox", "sms", "--page-json", "--limit", "10"],
        { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode).toBe(0);
      const page = JSON.parse(result.stdout.toString()) as { messages: Array<{ id: string }> };
      expect(page.messages.map((message) => message.id)).toContain(ownId);
      expect(page.messages.map((message) => message.id)).not.toContain(otherId);
    } finally {
      saveConfig(previous);
    }
  });

  test("Beeper is default and a device alone never activates KDE", () => {
    const previous = structuredClone(loadConfig());
    try {
      saveConfig({ ...previous, sms: { device: "Fixture Pixel" } });
      expect(resolveSmsBackend()).toBe("beeper");
      expect(resolveKdeSmsSettings()).toBeNull();
    } finally {
      saveConfig(previous);
    }
  });

  test("explicit kdeconnect config selects the unregistered rollback backend", () => {
    const previous = structuredClone(loadConfig());
    try {
      saveConfig({ ...previous, sms: { backend: "kdeconnect", device: "Fixture Pixel" } });
      expect(resolveSmsBackend()).toBe("kdeconnect");
      expect(resolveKdeSmsSettings()).toEqual({ device: "Fixture Pixel" });
    } finally {
      saveConfig(previous);
    }
  });

  test("explicit KDE reads, searches, and page JSON expose accountless rows only", async () => {
    const previous = structuredClone(loadConfig());
    const marker = `kde-isolation-${Date.now()}`;
    const kdeId = `${marker}-accountless`;
    const beeperId = `${marker}-beeper`;
    try {
      saveConfig({ ...previous, sms: { backend: "kdeconnect", device: "Fixture Pixel" } });
      store.upsertFullMessages([
        cachedSms(kdeId, "", "kde-chat", marker),
        cachedSms(beeperId, "gmessages-stale", "beeper-chat", marker),
      ]);
      store.recordFetch("sms");

      expect(
        (await smsProvider.inbox({ providerFlags: { backend: "kdeconnect" }, limit: 100 })).map(
          (message) => message.id,
        ),
      ).toContain(kdeId);
      expect(
        (await smsProvider.search?.(marker, { providerFlags: { backend: "kdeconnect" } }))?.map(
          (message) => message.id,
        ),
      ).toEqual([kdeId]);
      expect(
        (await smsProvider.read(kdeId, { providerFlags: { backend: "kdeconnect" } }))?.id,
      ).toBe(kdeId);
      expect(
        await smsProvider.read(beeperId, { providerFlags: { backend: "kdeconnect" } }),
      ).toBeNull();

      const result = Bun.spawnSync(
        [process.execPath, "src/cli.ts", "inbox", "sms", "--page-json", "--limit", "100"],
        { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode).toBe(0);
      const page = JSON.parse(result.stdout.toString()) as { messages: Array<{ id: string }> };
      expect(page.messages.map((message) => message.id)).toContain(kdeId);
      expect(page.messages.map((message) => message.id)).not.toContain(beeperId);
    } finally {
      saveConfig(previous);
      store.deleteMessages("sms", [kdeId, beeperId]);
    }
  });

  test("test-only backend overrides select Beeper despite ambient KDE config", () => {
    const previous = structuredClone(loadConfig());
    try {
      saveConfig({ ...previous, sms: { backend: "kdeconnect", device: "Fixture Pixel" } });
      expect(resolveSmsBackend({ backend: "beeper" })).toBe("beeper");
    } finally {
      saveConfig(previous);
    }
  });

  test("daemon active state and status are Beeper account-aware", () => {
    const previous = structuredClone(loadConfig());
    try {
      saveConfig({
        ...previous,
        beeper: { accessToken: "fixture-token", baseUrl: "http://127.0.0.1:23373" },
        sms: { backend: "beeper", accountId: "gmessages-daemon" },
      });
      const adapter = new SmsAdapter();
      expect(adapter.name).toBe("sms");
      expect(adapter.isActive()).toBe(true);
      expect(adapter.statusInfo()).toEqual({ backend: "beeper", accountId: "gmessages-daemon" });
    } finally {
      saveConfig(previous);
    }
  });

  test("legacy Messenger Beeper config resolves without rewriting ordinary reads", async () => {
    const previous = structuredClone(loadConfig());
    try {
      saveConfig({
        ...previous,
        beeper: undefined,
        messenger: {
          accountId: "facebook-legacy",
          accessToken: "legacy-token",
          baseUrl: "http://127.0.0.1:23373",
        },
      });
      const before = readFileSync(getConfigPath(), "utf-8");
      const { resolveMessengerSettings } = await import("../../providers/messenger.ts");
      expect(resolveMessengerSettings()).toMatchObject({
        accountId: "facebook-legacy",
        accessToken: "legacy-token",
      });
      expect(readFileSync(getConfigPath(), "utf-8")).toBe(before);
    } finally {
      saveConfig(previous);
    }
  });
});
