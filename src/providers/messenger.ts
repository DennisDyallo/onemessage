import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { getProviderFreshnessMs, loadConfig, saveConfig } from "../config.ts";
import { registerProvider } from "../registry.ts";
import * as store from "../store.ts";
import type { Attachment, MessageFull, MessagingProvider } from "../types.ts";
import { cacheSentMessage, inboxViaDaemon, readFromCacheOrFail } from "./shared.ts";

export const MESSENGER_DEFAULT_BASE_URL = "http://127.0.0.1:23373";
const WATERMARK_CURSOR = "messages.timestamp";
const WATERMARK_OVERLAP_MS = 1_000;

export interface MessengerSettings {
  accountId: string;
  accessToken: string;
  baseUrl: string;
}

function normalizeBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const isIpv4Loopback = isIP(url.hostname) === 4 && url.hostname.split(".")[0] === "127";
    const isLoopback =
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]" ||
      isIpv4Loopback;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) return null;
    return value.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export interface BeeperAttachment {
  filename?: string;
  fileName?: string;
  name?: string;
  title?: string;
  contentType?: string;
  mimeType?: string;
  type?: string;
  fileSize?: number;
  size?: number | { width?: number; height?: number };
}

export interface BeeperMessage {
  id: string;
  chatID: string;
  accountID: string;
  senderID: string;
  senderName?: string;
  timestamp: string | number;
  sortKey: string;
  type?: string;
  text?: string;
  isSender?: boolean;
  isUnread?: boolean;
  isDeleted?: boolean;
  isHidden?: boolean;
  attachments?: BeeperAttachment[];
}

export interface BeeperParticipant {
  id?: string;
  userID?: string;
  name?: string;
  fullName?: string;
}

export interface BeeperChat {
  id: string;
  accountID: string;
  title?: string;
  type?: "single" | "group";
  unreadCount?: number;
  isMarkedUnread?: boolean;
  lastReadMessageSortKey?: string | number;
  participants?:
    | BeeperParticipant[]
    | { items?: BeeperParticipant[]; hasMore?: boolean; total?: number };
}

interface MessageSearchResponse {
  items?: BeeperMessage[];
  chats?: Record<string, BeeperChat>;
  hasMore?: boolean;
  oldestCursor?: string;
  newestCursor?: string;
}

interface BeeperAccount {
  id?: string;
  accountID?: string;
  network?: string;
  bridge?: { type?: string };
  name?: string;
  user?: { name?: string; fullName?: string; username?: string };
}

export function resolveMessengerSettings(
  cliOverrides?: Record<string, unknown>,
): MessengerSettings | null {
  const config = loadConfig().messenger;
  const accountId = (cliOverrides?.accountId as string | undefined) ?? config?.accountId;
  const accessToken = (cliOverrides?.accessToken as string | undefined) ?? config?.accessToken;
  const configuredBaseUrl = (cliOverrides?.baseUrl as string | undefined) ?? config?.baseUrl;
  const baseUrl = normalizeBaseUrl(configuredBaseUrl || MESSENGER_DEFAULT_BASE_URL);
  if (!accountId?.trim() || !accessToken?.trim() || !baseUrl) return null;
  return { accountId: accountId.trim(), accessToken: accessToken.trim(), baseUrl };
}

function redact(value: string, token: string): string {
  return token ? value.split(token).join("[redacted]") : value;
}

async function messengerApi<T>(
  method: string,
  path: string,
  settings: MessengerSettings,
  body?: unknown,
): Promise<T> {
  const url = new URL(path, `${settings.baseUrl}/`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${settings.accessToken}`,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Messenger ${method} ${url.pathname}${url.search}: ${redact(detail, settings.accessToken)}`,
    );
  }

  const responseBody = await response.text().catch(() => "");
  const safeBody = redact(responseBody, settings.accessToken);
  if (!response.ok) {
    throw new Error(
      `Messenger ${method} ${url.pathname}${url.search}: ${response.status} ${safeBody}`.trim(),
    );
  }

  try {
    return JSON.parse(responseBody) as T;
  } catch {
    throw new Error(
      `Messenger ${method} ${url.pathname}${url.search}: ${response.status} invalid JSON ${safeBody}`.trim(),
    );
  }
}

export function messengerMessageId(chatId: string, messageId: string): string {
  return `chat:${encodeURIComponent(chatId)}:message:${encodeURIComponent(messageId)}`;
}

function attachmentLabel(attachment: BeeperAttachment): string {
  const type =
    `${attachment.contentType ?? attachment.mimeType ?? attachment.type ?? ""}`.toLowerCase();
  if (type.includes("image") || type.includes("photo")) return "Photo";
  if (type.includes("video")) return "Video";
  if (type.includes("audio") || type.includes("voice")) return "Audio";
  const filename =
    attachment.filename ?? attachment.fileName ?? attachment.name ?? attachment.title;
  return filename ? `File: ${filename}` : "Attachment";
}

function toAttachment(attachment: BeeperAttachment, index: number): Attachment {
  const filename =
    attachment.filename ??
    attachment.fileName ??
    attachment.name ??
    attachment.title ??
    `attachment-${index + 1}`;
  const rawContentType = attachment.contentType ?? attachment.mimeType ?? attachment.type;
  const contentType = rawContentType?.includes("/") ? rawContentType : "application/octet-stream";
  return {
    filename,
    contentType,
    size:
      typeof attachment.fileSize === "number"
        ? attachment.fileSize
        : typeof attachment.size === "number"
          ? attachment.size
          : 0,
  };
}

function messageTypePreview(type?: string): string | null {
  switch (type?.toUpperCase()) {
    case "IMAGE":
      return "[Image]";
    case "VIDEO":
      return "[Video]";
    case "VOICE":
      return "[Voice message]";
    case "AUDIO":
      return "[Audio]";
    case "FILE":
      return "[File]";
    case "STICKER":
      return "[Sticker]";
    case "LOCATION":
      return "[Location]";
    default:
      return null;
  }
}

function compareSortKeys(left: string, right: string | number): number {
  const rightString = String(right);
  if (/^\d+$/.test(left) && /^\d+$/.test(rightString)) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(rightString);
    return leftNumber === rightNumber ? 0 : leftNumber > rightNumber ? 1 : -1;
  }
  return left === rightString ? 0 : left > rightString ? 1 : -1;
}

function isMessageUnread(message: BeeperMessage, chat?: BeeperChat): boolean {
  if (message.isUnread !== undefined) return message.isUnread;
  if (message.isSender) return false;
  if (chat?.isMarkedUnread) return true;
  if (!chat?.unreadCount) return false;
  if (chat.lastReadMessageSortKey === undefined) return true;
  return compareSortKeys(message.sortKey, chat.lastReadMessageSortKey) > 0;
}

function messageDate(timestamp: string | number): string | null {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function beeperMessageToFull(message: BeeperMessage, chat?: BeeperChat): MessageFull | null {
  if (
    !message.id ||
    !message.chatID ||
    message.isDeleted ||
    message.isHidden ||
    message.type?.toLowerCase().includes("reaction")
  ) {
    return null;
  }

  const date = messageDate(message.timestamp);
  if (!date) return null;

  const rawAttachments = Array.isArray(message.attachments) ? message.attachments : [];
  const attachments = rawAttachments.map(toAttachment);
  const body = message.text ?? "";
  const mediaPreview =
    rawAttachments.length === 1
      ? `[${attachmentLabel(rawAttachments[0] ?? {})}]`
      : `[${rawAttachments.length} attachments]`;
  const preview = (
    body.trim()
      ? body
      : rawAttachments.length > 0
        ? mediaPreview
        : (messageTypePreview(message.type) ?? "[No content]")
  ).slice(0, 100);
  const chatTitle = chat?.title?.trim() || message.chatID;
  const participants = Array.isArray(chat?.participants)
    ? chat.participants
    : (chat?.participants?.items ?? []);
  const participant = participants.find(
    (item) => item.id === message.senderID || item.userID === message.senderID,
  );
  const senderName =
    message.senderName?.trim() || participant?.name || participant?.fullName || message.senderID;
  const isGroup = chat?.type === "group";

  return {
    id: messengerMessageId(message.chatID, message.id),
    provider: "messenger",
    account: message.accountID,
    from: { name: senderName, address: message.senderID },
    to: [{ name: chatTitle, address: message.chatID }],
    preview,
    body,
    bodyFormat: "text",
    date,
    unread: isMessageUnread(message, chat),
    hasAttachments: attachments.length > 0,
    attachments,
    isGroup,
    groupName: isGroup ? chatTitle : undefined,
    direction: message.isSender ? "out" : "in",
  };
}

function searchPath(settings: MessengerSettings, cursor?: string): string {
  const params = new URLSearchParams({
    accountIDs: settings.accountId,
    limit: "20",
    excludeLowPriority: "false",
  });
  const watermark = store.getCursor("messenger", settings.accountId, WATERMARK_CURSOR);
  if (watermark) {
    const timestamp = new Date(watermark).getTime();
    if (!Number.isNaN(timestamp)) {
      params.set("dateAfter", new Date(timestamp - WATERMARK_OVERLAP_MS).toISOString());
    }
  }
  if (cursor) {
    params.set("cursor", cursor);
    params.set("direction", "before");
  }
  return `/v1/messages/search?${params}`;
}

export async function fetchMessengerMessages(settings: MessengerSettings): Promise<void> {
  const isIncremental = store.getCursor("messenger", settings.accountId, WATERMARK_CURSOR) !== null;
  const messages: BeeperMessage[] = [];
  const chats = new Map<string, BeeperChat>();
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  do {
    const data = await messengerApi<MessageSearchResponse>(
      "GET",
      searchPath(settings, cursor),
      settings,
    );
    for (const [chatId, chat] of Object.entries(data.chats ?? {})) {
      if (chat.accountID === settings.accountId) chats.set(chatId, chat);
    }
    for (const message of data.items ?? []) {
      if (message.accountID === settings.accountId) messages.push(message);
    }

    if (!isIncremental || !data.hasMore) break;
    const nextCursor = data.oldestCursor;
    if (!nextCursor) throw new Error("Messenger pagination response omitted oldestCursor");
    if (seenCursors.has(nextCursor)) {
      throw new Error(`Messenger pagination repeated cursor ${nextCursor}`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  const fullMessages = messages
    .map((message) => beeperMessageToFull(message, chats.get(message.chatID)))
    .filter((message): message is MessageFull => message !== null);
  const removedMessageIds = messages
    .filter((message) => message.isDeleted || message.isHidden)
    .map((message) => messengerMessageId(message.chatID, message.id));
  if (removedMessageIds.length > 0) store.deleteMessages("messenger", removedMessageIds);
  if (fullMessages.length > 0) store.upsertFullMessages(fullMessages);

  let maxTimestamp = 0;
  for (const message of messages) {
    const timestamp = new Date(message.timestamp).getTime();
    if (!Number.isNaN(timestamp)) maxTimestamp = Math.max(maxTimestamp, timestamp);
  }
  if (maxTimestamp > 0) {
    store.setCursor(
      "messenger",
      settings.accountId,
      WATERMARK_CURSOR,
      new Date(maxTimestamp).toISOString(),
    );
  }
  store.recordFetch("messenger", settings.accountId);
}

export function isFacebookAccount(account: BeeperAccount): boolean {
  const network = account.network?.toLowerCase() ?? "";
  const bridgeType = account.bridge?.type?.toLowerCase() ?? "";
  return network === "facebook" || bridgeType === "facebookgo" || bridgeType.includes("facebook");
}

async function askSecret(prompt: string): Promise<string> {
  const readline = await import("node:readline");
  const { Writable } = await import("node:stream");
  const muted = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stdout.write(prompt);
  return new Promise((resolve) =>
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    }),
  );
}

async function configureMessengerConnection(): Promise<void> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));
  const inputBaseUrl = (
    await ask(`Beeper Client API URL (${MESSENGER_DEFAULT_BASE_URL}): `)
  ).trim();
  rl.close();
  const baseUrl = normalizeBaseUrl(inputBaseUrl || MESSENGER_DEFAULT_BASE_URL);
  if (!baseUrl) {
    throw new Error("Beeper Client API URL must use HTTPS or loopback HTTP");
  }
  const accessToken = await askSecret("Beeper Client API access token: ");
  if (!accessToken) throw new Error("Beeper Client API access token is required");

  const temporarySettings: MessengerSettings = { baseUrl, accessToken, accountId: "discovery" };
  const response = await messengerApi<
    BeeperAccount[] | { items?: BeeperAccount[]; accounts?: BeeperAccount[] }
  >("GET", "/v1/accounts", temporarySettings);
  const accounts = Array.isArray(response) ? response : (response.items ?? response.accounts ?? []);
  const matches = accounts
    .filter(isFacebookAccount)
    .filter((account) => account.id || account.accountID);
  if (matches.length === 0) {
    throw new Error("No already-connected Facebook Messenger account found in Beeper Desktop");
  }

  let selected = matches[0];
  if (matches.length > 1) {
    const selectRl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("Messenger accounts:");
    matches.forEach((account, index) => {
      const id = account.id ?? account.accountID ?? "unknown";
      const label =
        account.name ??
        account.user?.fullName ??
        account.user?.name ??
        account.user?.username ??
        id;
      console.log(`  ${index + 1}. ${label}`);
    });
    const answer = await new Promise<string>((resolve) =>
      selectRl.question("Select account: ", resolve),
    );
    selectRl.close();
    const index = Number.parseInt(answer, 10) - 1;
    if (!Number.isInteger(index) || !matches[index]) throw new Error("Invalid account selection");
    selected = matches[index];
  }

  const accountId = selected?.id ?? selected?.accountID;
  if (!accountId) throw new Error("Selected Messenger account has no account ID");
  const config = loadConfig();
  config.messenger = { accountId, accessToken, baseUrl };
  saveConfig(config);
  console.log("Messenger connection configured for Beeper Desktop.");
}

export const messengerProvider: MessagingProvider = {
  name: "messenger",
  displayName: "Messenger",

  isConfigured() {
    return resolveMessengerSettings() !== null;
  },

  async send(recipientId, body, opts) {
    const settings = resolveMessengerSettings(opts?.providerFlags);
    if (!settings) {
      return {
        ok: false,
        provider: "messenger",
        recipientId,
        error:
          "Messenger Beeper Client API connection not configured. Run: onemessage auth messenger",
      };
    }

    let finalBody = body;
    if (opts?.file) {
      try {
        finalBody = readFileSync(opts.file, "utf-8");
      } catch (error) {
        return {
          ok: false,
          provider: "messenger",
          recipientId,
          error: `Cannot read "${opts.file}": ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    try {
      const chat = await messengerApi<BeeperChat>(
        "GET",
        `/v1/chats/${encodeURIComponent(recipientId)}`,
        settings,
      );
      if (chat.accountID !== settings.accountId) {
        throw new Error("Messenger target chat does not belong to the configured Facebook account");
      }
      const path = `/v1/chats/${encodeURIComponent(recipientId)}/messages`;
      const result = await messengerApi<{ chatID: string; pendingMessageID: string }>(
        "POST",
        path,
        settings,
        { text: finalBody },
      );
      let rawMessageId = result.pendingMessageID;
      try {
        const resolved = await messengerApi<BeeperMessage>(
          "GET",
          `/v1/chats/${encodeURIComponent(result.chatID)}/messages/${encodeURIComponent(result.pendingMessageID)}`,
          settings,
        );
        if (resolved.id) rawMessageId = resolved.id;
      } catch {
        // POST succeeded. Keep the pending ID rather than retrying an ambiguous send.
      }
      const messageId = messengerMessageId(result.chatID, rawMessageId);
      cacheSentMessage({
        provider: "messenger",
        messageId,
        account: settings.accountId,
        fromAddress: settings.accountId,
        recipientId: result.chatID,
        recipientName: chat.title?.trim() || "",
        body: finalBody,
      });
      return { ok: true, provider: "messenger", recipientId, messageId };
    } catch (error) {
      return {
        ok: false,
        provider: "messenger",
        recipientId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async reply(messageId, body, opts) {
    const settings = resolveMessengerSettings(opts?.providerFlags);
    const original = readFromCacheOrFail("messenger", messageId);
    if (!settings || !original || original.account !== settings.accountId) {
      return {
        ok: false,
        provider: "messenger",
        recipientId: "",
        error: `Messenger message "${messageId}" not found for the configured Facebook account.`,
      };
    }
    const chatId = original.to[0]?.address;
    if (!chatId) {
      return {
        ok: false,
        provider: "messenger",
        recipientId: "",
        error: "Cannot reply: original Messenger message has no chat ID.",
      };
    }
    return messengerProvider.send(chatId, body, opts);
  },

  async inbox(opts) {
    const settings = resolveMessengerSettings(opts?.providerFlags);
    if (!settings) {
      console.error(
        "Messenger Beeper Client API connection not configured. Run: onemessage auth messenger",
      );
      return [];
    }
    return inboxViaDaemon({
      provider: "messenger",
      freshnessMs: getProviderFreshnessMs("messenger"),
      account: settings.accountId,
      fresh: opts?.fresh,
      cacheArgs: {
        limit: opts?.limit,
        unread: opts?.unread,
        since: opts?.since,
        sinceCachedAt: opts?.sinceCachedAt,
        from: opts?.from,
        account: settings.accountId,
      },
    });
  },

  resolveCacheAccount(providerFlags) {
    return resolveMessengerSettings(providerFlags)?.accountId;
  },

  async read(messageId, opts) {
    const settings = resolveMessengerSettings(opts?.providerFlags);
    const message = readFromCacheOrFail("messenger", messageId);
    return settings && message?.account === settings.accountId ? message : null;
  },

  async search(query, opts) {
    const settings = resolveMessengerSettings(opts?.providerFlags);
    if (!settings) return [];
    return store.searchCached(query, "messenger", {
      limit: opts?.limit,
      since: opts?.since,
      account: settings.accountId,
    });
  },

  async authenticate() {
    await configureMessengerConnection();
  },
};

registerProvider(messengerProvider);
