import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { BeeperClientConfig, MessengerProviderConfig } from "../config.ts";

export const BEEPER_DEFAULT_BASE_URL = "http://127.0.0.1:23373";

export interface BeeperConnection {
  accessToken: string;
  baseUrl: string;
}

export interface BeeperAccountSettings extends BeeperConnection {
  accountId: string;
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
  sortKey: string | number;
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
  phoneNumber?: string;
  username?: string;
  isSelf?: boolean;
}

export interface BeeperChat {
  id: string;
  chatID?: string;
  localChatID?: string;
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

export interface BeeperAccount {
  id?: string;
  accountID?: string;
  network?: string;
  bridge?: { type?: string };
  name?: string;
  user?: { name?: string; fullName?: string; username?: string };
}

export interface BeeperMessageSearchResponse {
  items?: BeeperMessage[];
  chats?: Record<string, BeeperChat>;
  hasMore?: boolean;
  oldestCursor?: string;
  newestCursor?: string;
}

export interface BeeperSendResult {
  chatId: string;
  messageId: string;
  state: "resolved" | "pending" | "unknown";
}

export function normalizeBeeperBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const isIpv4Loopback = isIP(url.hostname) === 4 && url.hostname.split(".")[0] === "127";
    const isLoopback =
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]" ||
      isIpv4Loopback;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) return null;
    return value.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function resolveBeeperConnection(
  config: BeeperClientConfig | undefined,
  cliOverrides?: Record<string, unknown>,
  legacy?: Pick<MessengerProviderConfig, "accessToken" | "baseUrl">,
): BeeperConnection | null {
  const accessToken =
    (cliOverrides?.accessToken as string | undefined) ?? config?.accessToken ?? legacy?.accessToken;
  const configuredBaseUrl =
    (cliOverrides?.baseUrl as string | undefined) ?? config?.baseUrl ?? legacy?.baseUrl;
  const baseUrl = normalizeBeeperBaseUrl(configuredBaseUrl || BEEPER_DEFAULT_BASE_URL);
  if (!accessToken?.trim() || !baseUrl) return null;
  return { accessToken: accessToken.trim(), baseUrl };
}

function redact(value: string, token: string): string {
  return token ? value.split(token).join("[redacted]") : value;
}

async function beeperRequest(
  label: string,
  method: string,
  path: string,
  connection: BeeperConnection,
  body?: unknown,
): Promise<{ responseBody: string; status: number }> {
  const url = new URL(path, `${connection.baseUrl}/`);
  if (url.origin !== new URL(connection.baseUrl).origin) {
    throw new Error(`${label} refused a Beeper API URL outside the configured origin`);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${connection.accessToken}`,
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
      `${label} ${method} ${url.pathname}${url.search}: ${redact(detail, connection.accessToken)}`,
    );
  }

  const responseBody = await response.text().catch(() => "");
  const safeBody = redact(responseBody, connection.accessToken);
  if (!response.ok) {
    throw new Error(
      `${label} ${method} ${url.pathname}${url.search}: ${response.status} ${safeBody}`.trim(),
    );
  }

  return { responseBody, status: response.status };
}

export async function beeperApi<T>(
  label: string,
  method: string,
  path: string,
  connection: BeeperConnection,
  body?: unknown,
): Promise<T> {
  const { responseBody, status } = await beeperRequest(label, method, path, connection, body);
  const safeBody = redact(responseBody, connection.accessToken);

  try {
    return JSON.parse(responseBody) as T;
  } catch {
    const url = new URL(path, `${connection.baseUrl}/`);
    throw new Error(
      `${label} ${method} ${url.pathname}${url.search}: ${status} invalid JSON ${safeBody}`.trim(),
    );
  }
}

export async function listBeeperAccounts(
  label: string,
  connection: BeeperConnection,
): Promise<BeeperAccount[]> {
  const response = await beeperApi<
    BeeperAccount[] | { items?: BeeperAccount[]; accounts?: BeeperAccount[] }
  >(label, "GET", "/v1/accounts", connection);
  return Array.isArray(response) ? response : (response.items ?? response.accounts ?? []);
}

export function beeperAccountId(account: BeeperAccount): string | undefined {
  return account.id ?? account.accountID;
}

export function beeperMessageId(chatId: string, messageId: string): string {
  return `chat:${encodeURIComponent(chatId)}:message:${encodeURIComponent(messageId)}`;
}

export function pendingBeeperMessageId(chatId: string, pendingMessageId: string): string {
  return `pending:${beeperMessageId(chatId, pendingMessageId)}`;
}

export function unknownBeeperMessageId(chatId: string, localMessageId: string): string {
  return `unknown:${beeperMessageId(chatId, localMessageId)}`;
}

export function parseBeeperMessageId(value: string): { chatId: string; messageId: string } | null {
  const match = value.match(/^chat:([^:]*):message:(.*)$/);
  if (!match?.[1] || match[2] === undefined) return null;
  try {
    return { chatId: decodeURIComponent(match[1]), messageId: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

export function parsePendingBeeperMessageId(
  value: string,
): { chatId: string; messageId: string } | null {
  return value.startsWith("pending:") ? parseBeeperMessageId(value.slice("pending:".length)) : null;
}

export async function searchBeeperMessages(
  label: string,
  settings: BeeperAccountSettings,
  options?: { dateAfter?: string; paginate?: boolean; limit?: number },
): Promise<{ messages: BeeperMessage[]; chats: Map<string, BeeperChat> }> {
  const messages: BeeperMessage[] = [];
  const chats = new Map<string, BeeperChat>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      accountIDs: settings.accountId,
      limit: String(options?.limit ?? 20),
      excludeLowPriority: "false",
    });
    if (options?.dateAfter) params.set("dateAfter", options.dateAfter);
    if (cursor) {
      params.set("cursor", cursor);
      params.set("direction", "before");
    }
    const data = await beeperApi<BeeperMessageSearchResponse>(
      label,
      "GET",
      `/v1/messages/search?${params}`,
      settings,
    );
    for (const [chatId, chat] of Object.entries(data.chats ?? {})) {
      if (chat.accountID === settings.accountId) chats.set(chatId, chat);
    }
    for (const message of data.items ?? []) {
      if (message.accountID === settings.accountId) messages.push(message);
    }

    if (!options?.paginate || !data.hasMore) break;
    const nextCursor = data.oldestCursor;
    if (!nextCursor) throw new Error(`${label} pagination response omitted oldestCursor`);
    if (seenCursors.has(nextCursor)) {
      throw new Error(`${label} pagination repeated cursor ${nextCursor}`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return { messages, chats };
}

export async function getBeeperChat(
  label: string,
  connection: BeeperConnection,
  chatId: string,
): Promise<BeeperChat> {
  return beeperApi<BeeperChat>(label, "GET", `/v1/chats/${encodeURIComponent(chatId)}`, connection);
}

export async function getBeeperMessage(
  label: string,
  connection: BeeperConnection,
  chatId: string,
  messageId: string,
): Promise<BeeperMessage> {
  return beeperApi<BeeperMessage>(
    label,
    "GET",
    `/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
    connection,
  );
}

export async function startBeeperDirectChat(
  label: string,
  settings: BeeperAccountSettings,
  phoneNumber: string,
): Promise<BeeperChat> {
  const started = await beeperApi<BeeperChat | { chatID?: string; id?: string }>(
    label,
    "POST",
    "/v1/chats/start",
    settings,
    { accountID: settings.accountId, user: { phoneNumber } },
  );
  const chatId = started.id ?? started.chatID;
  if (!chatId) throw new Error(`${label} chat start response omitted the global chat ID`);
  const chat = await getBeeperChat(label, settings, chatId);
  if (chat.accountID !== settings.accountId) {
    throw new Error(`${label} target chat does not belong to the configured account`);
  }
  return chat;
}

export async function sendBeeperTextOnce(
  label: string,
  connection: BeeperConnection,
  chatId: string,
  text: string,
): Promise<BeeperSendResult> {
  const { responseBody } = await beeperRequest(
    label,
    "POST",
    `/v1/chats/${encodeURIComponent(chatId)}/messages`,
    connection,
    { text },
  );
  let result: { chatID?: string; pendingMessageID?: string } | null = null;
  try {
    const parsed = JSON.parse(responseBody) as unknown;
    if (parsed && typeof parsed === "object") {
      result = parsed as { chatID?: string; pendingMessageID?: string };
    }
  } catch {
    // A 2xx POST may have delivered despite an unusable response body.
  }
  const resultChatId = typeof result?.chatID === "string" ? result.chatID : chatId;
  if (typeof result?.pendingMessageID !== "string" || !result.pendingMessageID) {
    return { chatId: resultChatId, messageId: randomUUID(), state: "unknown" };
  }
  const pendingMessageId = result.pendingMessageID;
  try {
    const resolved = await getBeeperMessage(label, connection, resultChatId, pendingMessageId);
    if (resolved.id) {
      return { chatId: resultChatId, messageId: resolved.id, state: "resolved" };
    }
  } catch {
    // The POST succeeded. Preserve its pending ID and never retry an ambiguous send.
  }
  return { chatId: resultChatId, messageId: pendingMessageId, state: "pending" };
}
