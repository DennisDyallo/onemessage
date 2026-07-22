import { readFileSync } from "node:fs";
import { getProviderFreshnessMs, loadConfig, saveConfig } from "../config.ts";
import { registerProvider } from "../registry.ts";
import * as store from "../store.ts";
import type { Attachment, MessageFull, MessagingProvider } from "../types.ts";
import {
  BEEPER_DEFAULT_BASE_URL,
  type BeeperAccount,
  type BeeperAccountSettings,
  type BeeperAttachment,
  type BeeperChat,
  type BeeperConnection,
  type BeeperMessage,
  beeperAccountId,
  beeperMessageId,
  getBeeperChat,
  getBeeperMessage,
  listBeeperAccounts,
  normalizeBeeperBaseUrl,
  parsePendingBeeperMessageId,
  pendingBeeperMessageId,
  resolveBeeperConnection,
  searchBeeperMessages,
  sendBeeperTextOnce,
  startBeeperDirectChat,
  unknownBeeperMessageId,
} from "./beeper-client.ts";
import {
  cacheSentMessage,
  inboxViaDaemon,
  normalizeRecipientForProvider,
  readFromCacheOrFail,
  resolveDefaultReply,
} from "./shared.ts";
import {
  fetchKdeSmsInbox,
  kdeConnectSmsBackend,
  pruneOptimisticSmsSentDuplicates,
  resolveKdeSmsSettings,
  toSmsMessage,
} from "./sms-kdeconnect.ts";

const WATERMARK_CURSOR = "messages.timestamp";
const WATERMARK_OVERLAP_MS = 1_000;

export type SmsBackend = "beeper" | "kdeconnect";

export interface BeeperSmsSettings extends BeeperAccountSettings {
  backend: "beeper";
}

export function resolveSmsBackend(cliOverrides?: Record<string, unknown>): SmsBackend {
  const override = cliOverrides?.backend;
  if (override === "beeper" || override === "kdeconnect") return override;
  return loadConfig().sms?.backend ?? "beeper";
}

export function resolveSmsSettings(
  cliOverrides?: Record<string, unknown>,
): BeeperSmsSettings | null {
  if (resolveSmsBackend(cliOverrides) !== "beeper") return null;
  const config = loadConfig();
  const accountId = (cliOverrides?.accountId as string | undefined) ?? config.sms?.accountId;
  const connection = resolveBeeperConnection(config.beeper, cliOverrides);
  if (!accountId?.trim() || !connection) return null;
  return { backend: "beeper", accountId: accountId.trim(), ...connection };
}

function chatParticipants(chat?: BeeperChat) {
  return Array.isArray(chat?.participants) ? chat.participants : (chat?.participants?.items ?? []);
}

function compareSortKeys(left: string | number, right: string | number): number {
  const leftString = String(left);
  const rightString = String(right);
  if (/^\d+$/.test(leftString) && /^\d+$/.test(rightString)) {
    const leftNumber = BigInt(leftString);
    const rightNumber = BigInt(rightString);
    return leftNumber === rightNumber ? 0 : leftNumber > rightNumber ? 1 : -1;
  }
  return leftString === rightString ? 0 : leftString > rightString ? 1 : -1;
}

function isMessageUnread(message: BeeperMessage, chat?: BeeperChat): boolean {
  if (message.isUnread !== undefined) return message.isUnread;
  if (message.isSender) return false;
  if (chat?.isMarkedUnread) return true;
  if (!chat?.unreadCount) return false;
  if (chat.lastReadMessageSortKey === undefined) return true;
  return compareSortKeys(message.sortKey, chat.lastReadMessageSortKey) > 0;
}

function toAttachment(attachment: BeeperAttachment, index: number): Attachment {
  const filename =
    attachment.filename ??
    attachment.fileName ??
    attachment.name ??
    attachment.title ??
    `attachment-${index + 1}`;
  const rawContentType = attachment.contentType ?? attachment.mimeType ?? attachment.type;
  return {
    filename,
    contentType: rawContentType?.includes("/") ? rawContentType : "application/octet-stream",
    size:
      typeof attachment.fileSize === "number"
        ? attachment.fileSize
        : typeof attachment.size === "number"
          ? attachment.size
          : 0,
  };
}

function attachmentPreview(attachments: BeeperAttachment[]): string {
  if (attachments.length !== 1) return `[${attachments.length} attachments]`;
  const attachment = attachments[0] ?? {};
  const type =
    `${attachment.contentType ?? attachment.mimeType ?? attachment.type ?? ""}`.toLowerCase();
  if (type.includes("image") || type.includes("photo")) return "[Photo]";
  if (type.includes("video")) return "[Video]";
  if (type.includes("audio") || type.includes("voice")) return "[Audio]";
  const filename =
    attachment.filename ?? attachment.fileName ?? attachment.name ?? attachment.title;
  return filename ? `[File: ${filename}]` : "[Attachment]";
}

function typePreview(type?: string): string {
  const labels: Record<string, string> = {
    IMAGE: "[Image]",
    VIDEO: "[Video]",
    VOICE: "[Voice message]",
    AUDIO: "[Audio]",
    FILE: "[File]",
    STICKER: "[Sticker]",
    LOCATION: "[Location]",
  };
  return labels[type?.toUpperCase() ?? ""] ?? "[No content]";
}

export function beeperSmsMessageToFull(
  message: BeeperMessage,
  chat?: BeeperChat,
): MessageFull | null {
  if (
    !message.id ||
    !message.chatID ||
    message.isDeleted ||
    message.isHidden ||
    message.type?.toLowerCase().includes("reaction")
  ) {
    return null;
  }
  const date = new Date(message.timestamp);
  if (Number.isNaN(date.getTime())) return null;

  const rawAttachments = Array.isArray(message.attachments) ? message.attachments : [];
  const attachments = rawAttachments.map(toAttachment);
  const body = message.text ?? "";
  const participants = chatParticipants(chat);
  const participant = participants.find(
    (item) => item.id === message.senderID || item.userID === message.senderID,
  );
  const senderAddress = participant?.phoneNumber || participant?.username || message.senderID;
  const senderName =
    message.senderName?.trim() ||
    participant?.name ||
    participant?.fullName ||
    participant?.phoneNumber ||
    message.senderID;
  const participantNames = participants
    .filter((item) => !item.isSelf)
    .map((item) => item.name || item.fullName || item.phoneNumber || item.username)
    .filter((value): value is string => Boolean(value));
  const isGroup = chat?.type === "group";
  const chatTitle =
    chat?.title?.trim() ||
    (isGroup && participantNames.length > 0 ? participantNames.join(", ") : undefined) ||
    participantNames[0] ||
    message.chatID;
  const preview = (
    body.trim()
      ? body
      : rawAttachments.length > 0
        ? attachmentPreview(rawAttachments)
        : typePreview(message.type)
  ).slice(0, 100);

  return {
    id: beeperMessageId(message.chatID, message.id),
    provider: "sms",
    account: message.accountID,
    from: { name: senderName, address: senderAddress },
    to: [{ name: chatTitle, address: message.chatID }],
    preview,
    body,
    bodyFormat: "text",
    date: date.toISOString(),
    unread: isMessageUnread(message, chat),
    hasAttachments: attachments.length > 0,
    attachments,
    isGroup,
    groupName: isGroup ? chatTitle : undefined,
    direction: message.isSender ? "out" : "in",
  };
}

function incrementalDateAfter(settings: BeeperSmsSettings): string | undefined {
  const watermark = store.getCursor("sms", settings.accountId, WATERMARK_CURSOR);
  if (!watermark) return undefined;
  const timestamp = new Date(watermark).getTime();
  return Number.isNaN(timestamp)
    ? undefined
    : new Date(timestamp - WATERMARK_OVERLAP_MS).toISOString();
}

export async function fetchBeeperSmsMessages(settings: BeeperSmsSettings): Promise<void> {
  const isIncremental = store.getCursor("sms", settings.accountId, WATERMARK_CURSOR) !== null;
  const { messages, chats } = await searchBeeperMessages("SMS", settings, {
    dateAfter: incrementalDateAfter(settings),
    paginate: isIncremental,
  });
  const fullMessages = messages
    .map((message) => beeperSmsMessageToFull(message, chats.get(message.chatID)))
    .filter((message): message is MessageFull => message !== null);
  const removedMessageIds = messages
    .filter((message) => message.isDeleted || message.isHidden)
    .map((message) => beeperMessageId(message.chatID, message.id));
  if (removedMessageIds.length > 0) store.deleteMessages("sms", removedMessageIds);
  if (fullMessages.length > 0) store.upsertFullMessages(fullMessages);
  await reconcilePendingBeeperSmsMessages(settings, chats);

  let maxTimestamp = 0;
  for (const message of messages) {
    const timestamp = new Date(message.timestamp).getTime();
    if (!Number.isNaN(timestamp)) maxTimestamp = Math.max(maxTimestamp, timestamp);
  }
  if (maxTimestamp > 0) {
    store.setCursor(
      "sms",
      settings.accountId,
      WATERMARK_CURSOR,
      new Date(maxTimestamp).toISOString(),
    );
  }
  store.recordFetch("sms", settings.accountId);
}

async function reconcilePendingBeeperSmsMessages(
  settings: BeeperSmsSettings,
  chats: Map<string, BeeperChat>,
): Promise<void> {
  const pendingRows = store.getCachedMessagesByIdPrefix("sms", settings.accountId, "pending:");
  for (const pending of pendingRows) {
    const identity = parsePendingBeeperMessageId(pending.id);
    if (!identity) continue;
    try {
      const resolved = await getBeeperMessage("SMS", settings, identity.chatId, identity.messageId);
      if (
        resolved.accountID !== settings.accountId ||
        resolved.chatID !== identity.chatId ||
        !resolved.id
      ) {
        continue;
      }
      if (resolved.isDeleted || resolved.isHidden) {
        store.deleteMessages("sms", [pending.id]);
        continue;
      }
      let chat = chats.get(identity.chatId);
      if (!chat) {
        chat = await getBeeperChat("SMS", settings, identity.chatId);
      }
      if (chat.accountID !== settings.accountId) continue;
      const canonical = beeperSmsMessageToFull(resolved, chat);
      if (!canonical) continue;
      store.upsertFullMessages([canonical]);
      store.deleteMessages("sms", [pending.id]);
    } catch {
      // Pending resolution is best-effort; retain the marked row until a later poll.
    }
  }
}

export function isGoogleMessagesAccount(account: BeeperAccount): boolean {
  const network = account.network?.toLowerCase().replace(/[\s_-]/g, "") ?? "";
  const bridge = account.bridge?.type?.toLowerCase().replace(/[\s_-]/g, "") ?? "";
  return (
    network.includes("gmessages") ||
    network.includes("googlemessages") ||
    bridge.includes("gmessages") ||
    bridge.includes("googlemessages")
  );
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

async function promptBeeperConnection(): Promise<BeeperConnection> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const inputBaseUrl = await new Promise<string>((resolve) =>
    rl.question(`Beeper Client API URL (${BEEPER_DEFAULT_BASE_URL}): `, resolve),
  );
  rl.close();
  const baseUrl = normalizeBeeperBaseUrl(inputBaseUrl.trim() || BEEPER_DEFAULT_BASE_URL);
  if (!baseUrl) throw new Error("Beeper Client API URL must use HTTPS or loopback HTTP");
  const accessToken = await askSecret("Beeper Client API access token: ");
  if (!accessToken) throw new Error("Beeper Client API access token is required");
  return { baseUrl, accessToken };
}

async function selectGoogleMessagesAccount(accounts: BeeperAccount[]): Promise<BeeperAccount> {
  const matches = accounts.filter(isGoogleMessagesAccount).filter(beeperAccountId);
  if (matches.length === 0) {
    throw new Error("No already-connected Google Messages account found in Beeper Desktop");
  }
  if (matches.length === 1 && matches[0]) return matches[0];

  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("Google Messages accounts:");
  matches.forEach((account, index) => {
    const id = beeperAccountId(account) ?? "unknown";
    const label =
      account.name ?? account.user?.fullName ?? account.user?.name ?? account.user?.username ?? id;
    console.log(`  ${index + 1}. ${label}`);
  });
  const answer = await new Promise<string>((resolve) => rl.question("Select account: ", resolve));
  rl.close();
  const selected = matches[Number.parseInt(answer, 10) - 1];
  if (!selected) throw new Error("Invalid account selection");
  return selected;
}

async function configureSms(): Promise<void> {
  const config = loadConfig();
  const existing = resolveBeeperConnection(config.beeper, undefined, config.messenger);
  const connection = existing ?? (await promptBeeperConnection());
  const accounts = await listBeeperAccounts("SMS", connection);
  const selected = await selectGoogleMessagesAccount(accounts);
  const accountId = beeperAccountId(selected);
  if (!accountId) throw new Error("Selected Google Messages account has no account ID");
  config.beeper = connection;
  config.sms = { ...config.sms, backend: "beeper", accountId };
  saveConfig(config);
  console.log("SMS/RCS connection configured for Beeper Desktop.");
}

async function sendViaBeeper(
  recipientId: string,
  body: string,
  opts?: Parameters<MessagingProvider["send"]>[2],
) {
  const settings = resolveSmsSettings(opts?.providerFlags);
  if (!settings) {
    return {
      ok: false as const,
      provider: "sms",
      recipientId,
      error: "SMS/RCS Beeper Client API connection not configured. Run: onemessage auth sms",
    };
  }
  if ((opts?.attachments?.length ?? 0) > 0) {
    return {
      ok: false as const,
      provider: "sms",
      recipientId,
      error: "SMS/RCS attachment sending is not supported by the Beeper backend.",
    };
  }

  let finalBody = body;
  if (opts?.file) {
    try {
      finalBody = readFileSync(opts.file, "utf-8");
    } catch (error) {
      return {
        ok: false as const,
        provider: "sms",
        recipientId,
        error: `Cannot read "${opts.file}": ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const normalized = normalizeRecipientForProvider("sms", recipientId);
  if (!normalized.ok) {
    return { ok: false as const, provider: "sms", recipientId, error: normalized.error };
  }
  const target = normalized.recipientId;
  try {
    const chat = /^\+\d+$/.test(target)
      ? await startBeeperDirectChat("SMS", settings, target)
      : await getBeeperChat("SMS", settings, target);
    if (chat.accountID !== settings.accountId) {
      throw new Error("SMS target chat does not belong to the configured Google Messages account");
    }
    const chatId = chat.id;
    if (!chatId) {
      throw new Error("SMS target did not resolve to a global Beeper chat ID");
    }
    const sent = await sendBeeperTextOnce("SMS", settings, chatId, finalBody);
    const messageId =
      sent.state === "resolved"
        ? beeperMessageId(sent.chatId, sent.messageId)
        : sent.state === "pending"
          ? pendingBeeperMessageId(sent.chatId, sent.messageId)
          : unknownBeeperMessageId(sent.chatId, sent.messageId);
    cacheSentMessage({
      provider: "sms",
      messageId,
      account: settings.accountId,
      fromAddress: settings.accountId,
      recipientId: sent.chatId,
      recipientName: chat.title?.trim() || target,
      body: finalBody,
    });
    return { ok: true as const, provider: "sms", recipientId: target, messageId };
  } catch (error) {
    return {
      ok: false as const,
      provider: "sms",
      recipientId: target,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const smsProvider: MessagingProvider = {
  name: "sms",
  displayName: "SMS/RCS",

  isConfigured() {
    return resolveSmsBackend() === "kdeconnect"
      ? kdeConnectSmsBackend.isConfigured()
      : resolveSmsSettings() !== null;
  },

  async send(recipientId, body, opts) {
    return resolveSmsBackend(opts?.providerFlags) === "kdeconnect"
      ? kdeConnectSmsBackend.send(recipientId, body, opts)
      : sendViaBeeper(recipientId, body, opts);
  },

  async reply(messageId, body, opts) {
    if (resolveSmsBackend(opts?.providerFlags) === "kdeconnect") {
      const original = await kdeConnectSmsBackend.read(messageId, opts);
      if (!original) {
        return { ok: false, provider: "sms", recipientId: "", error: "SMS message not found." };
      }
      try {
        return kdeConnectSmsBackend.send(resolveDefaultReply(original).recipientId, body, opts);
      } catch (error) {
        return {
          ok: false,
          provider: "sms",
          recipientId: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const settings = resolveSmsSettings(opts?.providerFlags);
    const original = readFromCacheOrFail("sms", messageId);
    if (!settings || !original || original.account !== settings.accountId) {
      return {
        ok: false,
        provider: "sms",
        recipientId: "",
        error: `SMS message "${messageId}" not found for the configured Google Messages account.`,
      };
    }
    const chatId = original.to[0]?.address;
    if (!chatId) {
      return { ok: false, provider: "sms", recipientId: "", error: "Cannot reply: no chat ID." };
    }
    return sendViaBeeper(chatId, body, opts);
  },

  async inbox(opts) {
    if (resolveSmsBackend(opts?.providerFlags) === "kdeconnect") {
      return kdeConnectSmsBackend.inbox(opts);
    }
    const settings = resolveSmsSettings(opts?.providerFlags);
    if (!settings) {
      console.error("SMS/RCS not configured. Run: onemessage auth sms");
      return [];
    }
    return inboxViaDaemon({
      provider: "sms",
      freshnessMs: getProviderFreshnessMs("sms"),
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
    return resolveSmsBackend(providerFlags) === "beeper"
      ? resolveSmsSettings(providerFlags)?.accountId
      : "";
  },

  async read(messageId, opts) {
    if (resolveSmsBackend(opts?.providerFlags) === "kdeconnect") {
      return kdeConnectSmsBackend.read(messageId, opts);
    }
    const settings = resolveSmsSettings(opts?.providerFlags);
    const message = readFromCacheOrFail("sms", messageId);
    return settings && message?.account === settings.accountId ? message : null;
  },

  async search(query, opts) {
    if (resolveSmsBackend(opts?.providerFlags) === "kdeconnect") {
      return store.searchCached(query, "sms", {
        limit: opts?.limit,
        since: opts?.since,
        account: "",
      });
    }
    const settings = resolveSmsSettings(opts?.providerFlags);
    if (!settings) return [];
    return store.searchCached(query, "sms", {
      limit: opts?.limit,
      since: opts?.since,
      account: settings.accountId,
    });
  },

  async authenticate() {
    await configureSms();
  },
};

export { fetchKdeSmsInbox, pruneOptimisticSmsSentDuplicates, resolveKdeSmsSettings, toSmsMessage };

registerProvider(smsProvider);
