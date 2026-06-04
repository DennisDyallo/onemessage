import { getProviderFreshnessMs, loadConfig } from "../config.ts";
import { registerProvider } from "../registry.ts";
import * as store from "../store.ts";
import type { MessageFull, MessagingProvider } from "../types.ts";
import {
  cacheSentMessage,
  cliExists,
  inboxViaDaemon,
  readFromCacheOrFail,
  runCli,
} from "./shared.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SmsSettings {
  device: string;
}

export function resolveSettings(cliOverrides?: Record<string, unknown>): SmsSettings | null {
  const config = loadConfig();
  const sms = config.sms;

  const device = (cliOverrides?.device as string) ?? sms?.device;
  if (!device) return null;

  return { device };
}

/** stderr noise filters for kdeconnect-cli */
const KDE_STDERR_FILTERS = [
  (line: string) => line.includes("QDBusError"),
  (line: string) => line.includes("error activating"),
];

function runKdeConnect(args: string[]) {
  return runCli("kdeconnect-cli", args, {
    stderrFilters: KDE_STDERR_FILTERS,
  });
}

function normalizePhone(value: string): string {
  return value.replace(/[^+\d]/g, "").replace(/^00/, "+");
}

function resolveDeviceId(device: string): string | null {
  if (/^[a-f0-9]{32}$/i.test(device)) return device;

  const result = runKdeConnect(["-a", "--id-name-only"]);
  if (!result.ok || !result.stdout) return null;

  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^([a-f0-9]{32})\s+(.+)$/i);
    if (match?.[1] && match[2] === device) return match[1];
  }

  return null;
}

function extractDbusString(block: string): string | null {
  const start = block.indexOf('string "');
  if (start === -1) return null;

  let value = "";
  let escaped = false;
  for (let i = start + 'string "'.length; i < block.length; i++) {
    const char = block[i];
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') return value;
    value += char;
  }

  return null;
}

function parseDbusConversationBlocks(stdout: string): string[] {
  const blocks: string[] = [];
  const lines = stdout.split("\n");
  let current: string[] | null = null;

  for (const line of lines) {
    if (line.includes("variant") && line.includes("struct {")) {
      current = [line];
      continue;
    }
    if (!current) continue;
    current.push(line);
    if (line === "      }" || line === "         }") {
      blocks.push(current.join("\n"));
      current = null;
    }
  }

  return blocks;
}

function requestSmsRefreshViaDbus(deviceId: string): void {
  const result = runCli(
    "dbus-send",
    [
      "--session",
      "--dest=org.kde.kdeconnect",
      "--type=method_call",
      "--print-reply",
      `/modules/kdeconnect/devices/${deviceId}`,
      "org.kde.kdeconnect.device.conversations.requestAllConversationThreads",
    ],
    { stderrFilters: KDE_STDERR_FILTERS, timeoutMs: 15_000 },
  );

  if (!result.ok && result.stderr) {
    process.stderr.write(`[sms] ${result.stderr}\n`);
  }

  // KDE Connect updates conversation cache asynchronously after the request.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_000);
}

function parseSmsMessagesFromDbusText(stdout: string, opts?: { from?: string }): MessageFull[] {
  const contactNames = store.getContactNamesByAddress("sms");
  const config = loadConfig();
  const ownAddress = normalizePhone(config.signal?.phone ?? "");
  const fromFilter = opts?.from ? normalizePhone(opts.from) : null;
  const messages: MessageFull[] = [];

  for (const block of parseDbusConversationBlocks(stdout)) {
    const body = extractDbusString(block);
    const timestampMatches = [...block.matchAll(/int64 (\d+)/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const timestamp = timestampMatches[0];
    const threadId = timestampMatches[1] ?? timestamp;
    const afterTimestamp = timestamp
      ? block.slice(block.indexOf(`int64 ${timestamp}`) + `int64 ${timestamp}`.length)
      : "";
    const statusValues = [...afterTimestamp.matchAll(/int32 (\d+)/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const messageBox = statusValues[0];
    const readStatus = statusValues[1];
    const arrayStart = block.indexOf("array [");
    const arrayEnd = block.indexOf("int64", arrayStart);
    const contactsText =
      arrayStart === -1 || arrayEnd === -1 ? "" : block.slice(arrayStart, arrayEnd);
    const contacts = [...contactsText.matchAll(/string "([^"]+)"/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const firstContact = contacts[0];

    if (!body || !timestamp || !firstContact) continue;
    if (fromFilter && !contacts.some((contact) => normalizePhone(contact) === fromFilter)) continue;

    const contact =
      contacts.find((candidate) => normalizePhone(candidate) !== ownAddress) ?? firstContact;
    const direction = messageBox === "2" ? "out" : "in";

    messages.push(
      toSmsMessage({
        id: `${threadId}:${timestamp}`,
        contact,
        body,
        timestamp: new Date(Number(timestamp)).toISOString(),
        direction,
        read: readStatus === "1",
        contactNames,
      }),
    );
  }

  return messages.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

function fetchSmsConversationsViaDbus(opts?: { from?: string }): MessageFull[] {
  const settings = resolveSettings();
  if (!settings) return [];

  const deviceId = resolveDeviceId(settings.device);
  if (!deviceId) return [];

  const result = runCli(
    "dbus-send",
    [
      "--session",
      "--dest=org.kde.kdeconnect",
      "--type=method_call",
      "--print-reply",
      `/modules/kdeconnect/devices/${deviceId}`,
      "org.kde.kdeconnect.device.conversations.activeConversations",
    ],
    { stderrFilters: KDE_STDERR_FILTERS, timeoutMs: 15_000 },
  );

  if (!result.ok || !result.stdout) {
    if (result.stderr) process.stderr.write(`[sms] ${result.stderr}\n`);
    return [];
  }

  return parseSmsMessagesFromDbusText(result.stdout, opts);
}

function canReadSmsViaDbus(): boolean {
  return cliExists("dbus-send") && resolveSettings() !== null;
}

function fetchThreadHistoryViaDbus(threadId: number): MessageFull[] {
  const settings = resolveSettings();
  if (!settings || !cliExists("dbus-monitor")) return [];

  const deviceId = resolveDeviceId(settings.device);
  if (!deviceId) return [];

  const result = runCli(
    "/bin/sh",
    [
      "-c",
      [
        "tmp=$(mktemp)",
        "dbus-monitor --session \"type='signal',interface='org.kde.kdeconnect.device.conversations'\" > \"$tmp\" 2>&1 & mon=$!",
        "sleep 1",
        `dbus-send --session --dest=org.kde.kdeconnect --type=method_call /modules/kdeconnect/devices/${deviceId} org.kde.kdeconnect.device.conversations.requestConversation int64:${threadId} int32:0 int32:100`,
        "sleep 6",
        "kill $mon 2>/dev/null",
        'cat "$tmp"',
        'rm -f "$tmp"',
      ].join("; "),
    ],
    { stderrFilters: KDE_STDERR_FILTERS, timeoutMs: 15_000 },
  );

  if (!result.ok || !result.stdout) {
    if (result.stderr) process.stderr.write(`[sms] ${result.stderr}\n`);
    return [];
  }

  const messages = parseSmsMessagesFromDbusText(result.stdout).filter((message) => {
    const [messageThreadId] = message.id.split(":");
    return messageThreadId === String(threadId);
  });

  return messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

// ---------------------------------------------------------------------------
// kdeconnect-read-sms wrapper (inbox)
// ---------------------------------------------------------------------------

interface SmsConversation {
  contact: string;
  preview: string;
  timestamp: string;
  direction: "in" | "out";
  read: boolean;
  thread_id: number;
}

interface SmsThreadMessage {
  body: string;
  timestamp: string;
  direction: "in" | "out";
  read: boolean;
  sub_id: number;
}

interface SmsThreadHistory {
  thread_id: number;
  contact: string;
  messages: SmsThreadMessage[];
}

/** Build a MessageFull for an SMS message given contact info and message data. */
export function toSmsMessage(opts: {
  id: string;
  contact: string;
  body: string;
  timestamp: string;
  direction: "in" | "out";
  read: boolean;
  contactNames?: Map<string, string>;
}): MessageFull {
  const { id, contact, body, timestamp, direction, read, contactNames } = opts;
  const contactName = contactNames?.get(contact) ?? contact;
  return {
    id,
    provider: "sms",
    from:
      direction === "in" ? { name: contactName, address: contact } : { name: "me", address: "me" },
    to:
      direction === "in"
        ? [{ name: "me", address: "me" }]
        : [{ name: contactName, address: contact }],
    preview: body.slice(0, 100),
    body,
    bodyFormat: "text",
    attachments: [],
    date: timestamp,
    unread: !read,
    hasAttachments: false,
    direction,
  };
}

export function pruneOptimisticSmsSentDuplicates(
  canonicalOutgoing: MessageFull[],
  windowMs = 10 * 60_000,
): void {
  if (canonicalOutgoing.length === 0) return;

  const d = store.getDb();
  const selectCandidate = d.prepare(`
    SELECT id
    FROM messages
    WHERE provider = 'sms'
      AND direction = 'out'
      AND thread_id IS NULL
      AND body = ?
      AND json_extract(to_json, '$[0].address') = ?
      AND COALESCE(json_extract(from_json, '$.address'), '') != 'me'
      AND ABS(strftime('%s', date) - strftime('%s', ?)) <= ?
    ORDER BY ABS(strftime('%s', date) - strftime('%s', ?)) ASC
    LIMIT 1
  `);
  const deleteCandidate = d.prepare("DELETE FROM messages WHERE provider = 'sms' AND id = ?");
  const windowSeconds = Math.ceil(windowMs / 1000);

  const tx = d.transaction(() => {
    for (const msg of canonicalOutgoing) {
      const recipient = msg.to[0]?.address;
      if (!recipient || !msg.body) continue;
      const candidate = selectCandidate.get(
        msg.body,
        recipient,
        msg.date,
        windowSeconds,
        msg.date,
      ) as { id: string } | null;
      if (candidate) deleteCandidate.run(candidate.id);
    }
  });
  tx();
}

function fetchSmsConversations(opts?: {
  unread?: boolean;
  fresh?: boolean;
  from?: string;
}): MessageFull[] {
  if (canReadSmsViaDbus()) {
    const settings = resolveSettings();
    const deviceId = settings ? resolveDeviceId(settings.device) : null;
    if (deviceId) {
      if (opts?.fresh) requestSmsRefreshViaDbus(deviceId);
      const messages = fetchSmsConversationsViaDbus(opts);
      return opts?.unread ? messages.filter((message) => message.unread) : messages;
    }
  }

  if (!cliExists("kdeconnect-read-sms")) {
    return [];
  }

  const args: string[] = ["--json"];
  if (opts?.unread) args.push("--unread");
  if (opts?.fresh) args.push("--refresh");
  if (opts?.from) args.push("--thread", opts.from);

  const result = runCli("kdeconnect-read-sms", args, {
    stderrFilters: KDE_STDERR_FILTERS,
    timeoutMs: 15_000,
  });

  if (!result.ok) {
    if (result.stderr) process.stderr.write(`[sms] ${result.stderr}\n`);
    return [];
  }

  if (!result.stdout || result.stdout === "[]") return [];

  try {
    const contactNames = store.getContactNamesByAddress("sms");
    const convs: SmsConversation[] = JSON.parse(result.stdout);
    return convs.map((c) =>
      toSmsMessage({
        id: String(c.thread_id),
        contact: c.contact,
        body: c.preview,
        timestamp: c.timestamp,
        direction: c.direction,
        read: c.read,
        contactNames,
      }),
    );
  } catch {
    process.stderr.write("[sms] Failed to parse kdeconnect-read-sms output\n");
    return [];
  }
}

/**
 * Fetch full conversation history for a thread via requestConversation DBus method.
 * Returns all messages in chronological order (oldest first).
 */
function fetchThreadHistory(threadId: number): MessageFull[] {
  const result = runCli("kdeconnect-read-sms", ["--json", "--conversation", String(threadId)], {
    stderrFilters: KDE_STDERR_FILTERS,
    timeoutMs: 20_000,
  });

  if (!result.ok) {
    if (result.stderr) process.stderr.write(`[sms] ${result.stderr}\n`);
    return [];
  }

  if (!result.stdout || result.stdout === "{}") return [];

  try {
    const history: SmsThreadHistory = JSON.parse(result.stdout);
    if (!history.messages || history.messages.length === 0) return [];

    const contactNames = store.getContactNamesByAddress("sms");
    return history.messages.map((m) =>
      toSmsMessage({
        id: `${history.thread_id}:${m.sub_id}`,
        contact: history.contact,
        body: m.body,
        timestamp: m.timestamp,
        direction: m.direction,
        read: m.read,
        contactNames,
      }),
    );
  } catch {
    process.stderr.write("[sms] Failed to parse thread history output\n");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Thread rendering
// ---------------------------------------------------------------------------

/**
 * Combine an array of individual thread messages into a single MessageFull
 * with the conversation body rendered as a readable transcript.
 */
function threadToFullMessage(messages: MessageFull[], threadId: string): MessageFull {
  // Determine the contact from the first incoming message, or first message at all
  const firstIncoming = messages.find((m) => m.direction === "in");
  const contact = firstIncoming?.from ??
    messages[0]?.to?.[0] ?? { name: "unknown", address: "unknown" };

  const body = messages
    .map((m) => {
      const dir = m.direction === "in" ? "<" : ">";
      const date = new Date(m.date).toLocaleString();
      return `[${date}] ${dir} ${m.body}`;
    })
    .join("\n");

  return {
    id: threadId,
    provider: "sms",
    from: contact,
    to: [],
    preview: `Thread with ${contact.name || contact.address} (${messages.length} messages)`,
    body,
    bodyFormat: "text",
    attachments: [],
    date: messages[messages.length - 1]?.date ?? new Date().toISOString(),
    unread: messages.some((m) => m.unread),
    hasAttachments: false,
    direction: "in",
  };
}

// ---------------------------------------------------------------------------
// Fetch-and-cache (callable by daemon)
// ---------------------------------------------------------------------------

export function fetchSmsInbox(opts?: { unread?: boolean; fresh?: boolean; from?: string }): void {
  const messages = fetchSmsConversations(opts);
  if (messages.length > 0) {
    const incoming = messages.filter((m) => m.direction === "in");
    const outgoing = messages.filter((m) => m.direction === "out");
    if (incoming.length > 0) store.upsertFullMessages(incoming);
    if (outgoing.length > 0) {
      store.upsertFullMessages(outgoing);
      pruneOptimisticSmsSentDuplicates(outgoing);
    }
    console.error(`[sms] Stored ${incoming.length} in + ${outgoing.length} out messages`);
  }
  store.recordFetch("sms");
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const smsProvider: MessagingProvider = {
  name: "sms",
  displayName: "SMS (KDE Connect)",

  isConfigured() {
    return cliExists("kdeconnect-cli") && resolveSettings() !== null;
  },

  async send(recipientId, body, opts) {
    const settings = resolveSettings(opts?.providerFlags);
    if (!settings) {
      return {
        ok: false,
        provider: "sms",
        recipientId,
        error: "SMS not configured. Run: onemessage auth sms",
      };
    }

    const args = ["--name", settings.device, "--send-sms", body, "--destination", recipientId];

    if (opts?.attachments) {
      for (const attachment of opts.attachments) {
        args.push("--attachment", attachment);
      }
    }

    const result = runKdeConnect(args);

    if (result.ok) {
      cacheSentMessage({
        provider: "sms",
        fromAddress: settings.device,
        recipientId,
        body,
        hasAttachments: (opts?.attachments?.length ?? 0) > 0,
      });
      return { ok: true, provider: "sms", recipientId };
    } else {
      const error =
        result.stderr || result.stdout || `kdeconnect-cli exited with code ${result.exitCode}`;
      return { ok: false, provider: "sms", recipientId, error };
    }
  },

  async inbox(opts) {
    const hasReader = cliExists("kdeconnect-read-sms") || cliExists("dbus-send");

    if (!hasReader) {
      // Fall back to cache only
      return store.getCachedInbox("sms", {
        limit: opts?.limit,
        unread: opts?.unread,
        sinceCachedAt: opts?.sinceCachedAt,
      });
    }

    return inboxViaDaemon({
      provider: "sms",
      freshnessMs: getProviderFreshnessMs("sms"),
      fresh: opts?.fresh,
      cacheArgs: {
        limit: opts?.limit,
        unread: opts?.unread,
        since: opts?.since,
        sinceCachedAt: opts?.sinceCachedAt,
        from: opts?.from,
      },
      fallbackFetch: () => fetchSmsInbox(opts),
    });
  },

  async read(messageId, opts) {
    // If messageId contains ":", it's a specific message within a thread (threadId:subId)
    // If it's a plain number, it's a thread_id — fetch full thread history
    if (!messageId.includes(":")) {
      const threadId = parseInt(messageId, 10);
      if (!Number.isNaN(threadId)) {
        // Check cache first (unless fresh requested)
        if (!opts?.fresh) {
          const cached = store.getThreadMessages("sms", messageId);
          if (cached.length > 0) {
            // Return the full thread as a single "message" with concatenated body
            return threadToFullMessage(cached, messageId);
          }
        }

        // Fetch from phone
        const dbusMessages = fetchThreadHistoryViaDbus(threadId);
        const messages =
          dbusMessages.length > 0 || !cliExists("kdeconnect-read-sms")
            ? dbusMessages
            : fetchThreadHistory(threadId);
        if (messages.length > 0) {
          const incoming = messages.filter((m) => m.direction === "in");
          const outgoing = messages.filter((m) => m.direction === "out");
          if (incoming.length > 0) store.upsertFullMessages(incoming, messageId);
          if (outgoing.length > 0) {
            store.upsertFullMessages(outgoing, messageId);
            pruneOptimisticSmsSentDuplicates(outgoing);
          }
          console.error(
            `[sms] Stored ${incoming.length} in + ${outgoing.length} out messages (thread ${threadId})`,
          );
          return threadToFullMessage(messages, messageId);
        }
      }
    }

    return readFromCacheOrFail("sms", messageId);
  },
};

registerProvider(smsProvider);
