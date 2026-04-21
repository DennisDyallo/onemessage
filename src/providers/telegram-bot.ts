import { loadConfig } from "../config.ts";
import { registerProvider } from "../registry.ts";
import * as store from "../store.ts";
import type { MessageEnvelope, MessageFull, MessagingProvider } from "../types.ts";
import { cacheSentMessage, readFromCacheOrFail } from "./shared.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface TelegramBotSettings {
  botToken: string;
}

function resolveSettings(cliOverrides?: Record<string, unknown>): TelegramBotSettings | null {
  const token = (cliOverrides?.botToken as string) ?? loadConfig().telegramBot?.botToken;
  if (!token) return null;
  return { botToken: token };
}

// ---------------------------------------------------------------------------
// Telegram Bot API helpers
// ---------------------------------------------------------------------------

const API_BASE = "https://api.telegram.org";

async function apiPost(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) {
    throw new Error(`Telegram API error (${method}): ${json.description ?? res.status}`);
  }
  return json.result;
}

async function apiGet(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const entries: [string, string][] = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, String(v)]);
  const qs = new URLSearchParams(entries).toString();
  const url = `${API_BASE}/bot${token}/${method}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) {
    throw new Error(`Telegram API error (${method}): ${json.description ?? res.status}`);
  }
  return json.result;
}

// ---------------------------------------------------------------------------
// Update parsing
// ---------------------------------------------------------------------------

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: {
    id: number;
    type: string;
    title?: string;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  from?: { id: number; first_name?: string; last_name?: string; username?: string };
  text?: string;
  caption?: string;
  photo?: unknown[];
  document?: unknown;
  voice?: unknown;
  audio?: unknown;
  video?: unknown;
}

function senderName(msg: TelegramMessage): string {
  const from = msg.from;
  if (!from) return msg.chat.title ?? String(msg.chat.id);
  const parts = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return parts || from.username || String(from.id);
}

function chatName(msg: TelegramMessage): string {
  const c = msg.chat;
  return (
    c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || String(c.id))
  );
}

export function updateToEnvelope(update: TelegramUpdate): MessageEnvelope | null {
  const msg = update.message ?? update.channel_post;
  if (!msg) return null;

  const body = msg.text ?? msg.caption ?? "";
  const fromAddr = String(msg.from?.id ?? msg.chat.id);
  const chatId = String(msg.chat.id);
  const hasAttachments = !!(msg.photo || msg.document || msg.voice || msg.audio || msg.video);

  return {
    id: String(update.update_id),
    provider: "telegram-bot",
    from: { name: senderName(msg), address: fromAddr },
    to: [{ name: chatName(msg), address: chatId }],
    preview: body.slice(0, 100),
    date: new Date(msg.date * 1000).toISOString(),
    unread: true,
    hasAttachments,
    isGroup: msg.chat.type === "group" || msg.chat.type === "supergroup",
    groupName: msg.chat.title ?? undefined,
  };
}

export function updateToFull(update: TelegramUpdate): MessageFull | null {
  const envelope = updateToEnvelope(update);
  if (!envelope) return null;
  const msg = update.message ?? update.channel_post;
  if (!msg) return null;
  const body = msg.text ?? msg.caption ?? "";

  return {
    ...envelope,
    direction: "in",
    body,
    bodyFormat: "text",
    attachments: [],
  };
}

// ---------------------------------------------------------------------------
// Offset tracking (derived from cached messages to avoid re-fetching)
// ---------------------------------------------------------------------------

function nextOffset(): number | undefined {
  // Get the latest cached update_id; offset = update_id + 1 tells Telegram
  // to only return newer updates. Returns undefined on first run (no offset).
  const recent = store.getCachedInbox("telegram-bot", { limit: 1 });
  if (recent.length === 0) return undefined;
  const latestId = Number(recent[0]?.id);
  if (Number.isNaN(latestId)) return undefined;
  return latestId + 1;
}

// ---------------------------------------------------------------------------
// Fetch and cache (callable by daemon)
// ---------------------------------------------------------------------------

export async function fetchTelegramBotUpdates(token: string): Promise<void> {
  const offset = nextOffset();
  const updates = (await apiGet(token, "getUpdates", {
    offset,
    limit: 100,
    timeout: 0,
  })) as TelegramUpdate[];

  if (!Array.isArray(updates) || updates.length === 0) {
    store.recordFetch("telegram-bot", "bot");
    return;
  }

  const fulls = updates.map(updateToFull).filter(Boolean) as MessageFull[];
  if (fulls.length > 0) {
    store.upsertFullMessages(fulls);
  }

  store.recordFetch("telegram-bot", "bot");
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const telegramBotProvider: MessagingProvider = {
  name: "telegram-bot",
  displayName: "Telegram Bot (Bot API)",

  isConfigured() {
    return resolveSettings() !== null;
  },

  async send(recipientId, body, opts) {
    const settings = resolveSettings(opts?.providerFlags);
    if (!settings) {
      return {
        ok: false,
        provider: "telegram-bot",
        recipientId,
        error: "Telegram bot not configured. Run: onemessage auth telegram-bot",
      };
    }

    try {
      const result = (await apiPost(settings.botToken, "sendMessage", {
        chat_id: recipientId,
        text: body,
      })) as { message_id: number };

      const messageId = String(result.message_id);
      cacheSentMessage({
        provider: "telegram-bot",
        messageId,
        fromAddress: "bot",
        recipientId,
        body,
      });

      return { ok: true, provider: "telegram-bot", recipientId, messageId };
    } catch (err) {
      return {
        ok: false,
        provider: "telegram-bot",
        recipientId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async inbox(opts) {
    const settings = resolveSettings(opts?.providerFlags);
    if (!settings) {
      console.error("Telegram bot not configured. Run: onemessage auth telegram-bot");
      return [];
    }

    if (store.isFresh("telegram-bot", 30_000, "bot") && !opts?.fresh) {
      return store.getCachedInbox("telegram-bot", {
        limit: opts?.limit,
        unread: opts?.unread,
        since: opts?.since,
        from: opts?.from,
      });
    }

    try {
      await fetchTelegramBotUpdates(settings.botToken);
    } catch (err) {
      console.error(
        `[telegram-bot] Failed to fetch updates: ${err instanceof Error ? err.message : err}`,
      );
    }

    return store.getCachedInbox("telegram-bot", {
      limit: opts?.limit,
      unread: opts?.unread,
      since: opts?.since,
      from: opts?.from,
    });
  },

  async read(messageId, _opts) {
    return readFromCacheOrFail("telegram-bot", messageId);
  },

  async search(query, opts) {
    return store.searchCached(query, "telegram-bot", {
      limit: opts?.limit,
      since: opts?.since,
    });
  },
};

registerProvider(telegramBotProvider);
