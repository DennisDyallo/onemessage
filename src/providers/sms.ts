import { registerProvider } from "../registry.ts";
import { loadConfig } from "../config.ts";
import * as store from "../store.ts";
import { cliExists, runCli, readFromCacheOrFail, cacheSentMessage } from "./shared.ts";
import type { MessagingProvider, MessageFull } from "../types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SmsSettings {
  device: string;
}

function resolveSettings(cliOverrides?: Record<string, unknown>): SmsSettings | null {
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
function toSmsMessage(opts: {
  id: string;
  contact: string;
  body: string;
  timestamp: string;
  direction: "in" | "out";
  read: boolean;
}): MessageFull {
  const { id, contact, body, timestamp, direction, read } = opts;
  return {
    id,
    provider: "sms",
    from: direction === "in" ? { name: contact, address: contact } : null,
    to: direction === "out" ? [{ name: contact, address: contact }] : [],
    preview: body.slice(0, 100),
    body,
    bodyFormat: "text",
    attachments: [],
    date: timestamp,
    unread: !read,
    hasAttachments: false,
  };
}

function fetchSmsConversations(opts?: { unread?: boolean; fresh?: boolean; from?: string }): MessageFull[] {
  const args = ["kdeconnect-read-sms", "--json"];
  if (opts?.unread) args.push("--unread");
  if (opts?.fresh) args.push("--refresh");
  if (opts?.from) args.push("--thread", opts.from);

  const result = Bun.spawnSync(args, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });

  if (result.exitCode !== 0) {
    const err = result.stderr.toString().trim();
    if (err) process.stderr.write(`[sms] ${err}\n`);
    return [];
  }

  const stdout = result.stdout.toString().trim();
  if (!stdout || stdout === "[]") return [];

  try {
    const convs: SmsConversation[] = JSON.parse(stdout);
    return convs.map((c) => toSmsMessage({
      id: String(c.thread_id),
      contact: c.contact,
      body: c.preview,
      timestamp: c.timestamp,
      direction: c.direction,
      read: c.read,
    }));
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
  const args = ["kdeconnect-read-sms", "--json", "--conversation", String(threadId)];

  const result = Bun.spawnSync(args, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000, // longer timeout for async signal wait
  });

  if (result.exitCode !== 0) {
    const err = result.stderr.toString().trim();
    if (err) process.stderr.write(`[sms] ${err}\n`);
    return [];
  }

  const stdout = result.stdout.toString().trim();
  if (!stdout || stdout === "{}") return [];

  try {
    const history: SmsThreadHistory = JSON.parse(stdout);
    if (!history.messages || history.messages.length === 0) return [];

    return history.messages.map((m) => toSmsMessage({
      id: `${history.thread_id}:${m.sub_id}`,
      contact: history.contact,
      body: m.body,
      timestamp: m.timestamp,
      direction: m.direction,
      read: m.read,
    }));
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
  const firstIncoming = messages.find((m) => m.from !== null);
  const contact = firstIncoming?.from ?? messages[0]?.to?.[0] ?? { name: "unknown", address: "unknown" };

  const body = messages
    .map((m) => {
      const dir = m.from ? "<" : ">";
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
  };
}

// ---------------------------------------------------------------------------
// Fetch-and-cache (callable by daemon)
// ---------------------------------------------------------------------------

export function fetchSmsInbox(opts?: { unread?: boolean; fresh?: boolean; from?: string }): void {
  const messages = fetchSmsConversations(opts);
  if (messages.length > 0) {
    store.upsertFullMessages(messages);
  }
  store.recordFetch("sms");
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const FRESHNESS_MS = 2 * 60_000; // 2 minutes

const smsProvider: MessagingProvider = {
  name: "sms",
  displayName: "SMS (KDE Connect)",

  isConfigured() {
    return cliExists("kdeconnect-cli") && resolveSettings() !== null;
  },

  async send(recipientId, body, opts) {
    const settings = resolveSettings(opts?.providerFlags);
    if (!settings) {
      return { ok: false, provider: "sms", recipientId, error: "SMS not configured. Run: onemessage auth sms" };
    }

    const args = [
      "--name", settings.device,
      "--send-sms", body,
      "--destination", recipientId,
    ];

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
      const error = result.stderr || result.stdout || `kdeconnect-cli exited with code ${result.exitCode}`;
      return { ok: false, provider: "sms", recipientId, error };
    }
  },

  async inbox(opts) {
    const hasReader = cliExists("kdeconnect-read-sms");

    if (!hasReader) {
      // Fall back to cache only
      return store.getCachedInbox("sms", { limit: opts?.limit, unread: opts?.unread });
    }

    const needsFetch = opts?.fresh || !store.isFresh("sms", FRESHNESS_MS);

    if (needsFetch) {
      fetchSmsInbox({
        unread: opts?.unread,
        fresh: opts?.fresh,
        from: opts?.from,
      });
    }

    return store.getCachedInbox("sms", {
      limit: opts?.limit,
      unread: opts?.unread,
      since: opts?.since,
      from: opts?.from,
    });
  },

  async read(messageId, opts) {
    // If messageId contains ":", it's a specific message within a thread (threadId:subId)
    // If it's a plain number, it's a thread_id — fetch full thread history
    if (!messageId.includes(":") && cliExists("kdeconnect-read-sms")) {
      const threadId = parseInt(messageId, 10);
      if (!isNaN(threadId)) {
        // Check cache first (unless fresh requested)
        if (!opts?.fresh) {
          const cached = store.getThreadMessages("sms", messageId);
          if (cached.length > 0) {
            // Return the full thread as a single "message" with concatenated body
            return threadToFullMessage(cached, messageId);
          }
        }

        // Fetch from phone
        const messages = fetchThreadHistory(threadId);
        if (messages.length > 0) {
          store.upsertFullMessages(messages, "in", messageId);
          return threadToFullMessage(messages, messageId);
        }
      }
    }

    return readFromCacheOrFail("sms", messageId);
  },
};

registerProvider(smsProvider);
