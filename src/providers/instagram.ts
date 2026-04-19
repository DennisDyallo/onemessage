import { registerProvider } from "../registry.ts";
import { loadConfig } from "../config.ts";
import * as store from "../store.ts";
import { cliExists, runCli, runCliAsync, readFromCacheOrFail, cacheSentMessage } from "./shared.ts";
import type { MessagingProvider, MessageEnvelope, MessageFull } from "../types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface InstagramSettings {
  username: string;
}

function resolveSettings(cliOverrides?: Record<string, unknown>): InstagramSettings | null {
  const username = (cliOverrides?.username as string) ?? loadConfig().instagram?.username;
  if (!username) return null;
  return { username };
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

const CLI = "instagram-cli";
const CLI_TIMEOUT_MS = 60_000; // instagram-cli has Node.js startup overhead + thread reads

/** stderr noise from Ink/React rendering */
const STDERR_FILTERS = [
  (line: string) => line.startsWith("WARNING"),
  (line: string) => line.includes("ExperimentalWarning"),
  (line: string) => line.includes("ink"),
  (line: string) => line.trim() === "",
];

function runInstagramCli(args: string[], timeoutMs = CLI_TIMEOUT_MS) {
  return runCli(CLI, args, { stderrFilters: STDERR_FILTERS, timeoutMs });
}

async function runInstagramCliAsync(args: string[], timeoutMs = CLI_TIMEOUT_MS) {
  return runCliAsync(CLI, args, { stderrFilters: STDERR_FILTERS, timeoutMs });
}

interface CliJsonResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function parseCliJson<T>(stdout: string): CliJsonResult<T> {
  try {
    return JSON.parse(stdout) as CliJsonResult<T>;
  } catch {
    return { ok: false, error: `Failed to parse instagram-cli output: ${stdout.slice(0, 200)}` };
  }
}

// ---------------------------------------------------------------------------
// Types for instagram-cli JSON output
// ---------------------------------------------------------------------------

interface InboxThread {
  id: string;
  title: string;
  users: string[];
  lastMessage?: {
    id: string;
    itemType: string;
    text?: string;
    timestamp: string;
  };
  lastActivity: string;
  unread: boolean;
}

interface ReadMessage {
  id: string;
  itemType: string;
  text?: string;
  media?: { id: string; mediaType: number };
  userId: string;
  username: string;
  timestamp: string;
  isOutgoing: boolean;
}

interface ReadResult {
  threadId: string;
  messages: ReadMessage[];
  cursor?: string;
  markedSeen?: boolean;
}

interface SendResult {
  threadId: string;
  recipient: string;
  messageId: string;
  sent: boolean;
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

function threadToEnvelope(thread: InboxThread): MessageEnvelope {
  const fromName = thread.title;
  const fromAddr = thread.users[0] ?? thread.id;

  return {
    id: thread.id,
    provider: "instagram",
    from: { name: fromName, address: fromAddr },
    to: [{ name: "me", address: "me" }],
    preview: thread.lastMessage?.text ?? `[${thread.lastMessage?.itemType ?? "no messages"}]`,
    date: thread.lastActivity,
    unread: thread.unread,
    hasAttachments: false,
  };
}

function readMessageToFull(msg: ReadMessage, threadId: string, threadTitle: string): MessageFull {
  const from = msg.isOutgoing
    ? { name: "me", address: "me" }
    : { name: threadTitle || msg.username, address: msg.username };
  const to = msg.isOutgoing
    ? [{ name: threadTitle, address: threadId }]
    : [{ name: "me", address: "me" }];

  return {
    id: msg.id,
    provider: "instagram",
    from,
    to,
    preview: msg.text ?? `[${msg.itemType}]`,
    body: msg.text ?? `[${msg.itemType}]`,
    bodyFormat: "text",
    date: msg.timestamp,
    unread: false,
    hasAttachments: msg.media !== undefined,
    attachments: [],
  };
}

// ---------------------------------------------------------------------------
// Fetch and cache (callable by daemon)
// ---------------------------------------------------------------------------

const MAX_THREADS_PER_SYNC = 1;
const THREAD_MESSAGE_LIMIT = 10;
const INTER_REQUEST_DELAY_MIN_MS = 3_000;
const INTER_REQUEST_DELAY_MAX_MS = 6_000;

function randomDelay(): Promise<void> {
  const ms = Math.floor(Math.random() * (INTER_REQUEST_DELAY_MAX_MS - INTER_REQUEST_DELAY_MIN_MS + 1)) + INTER_REQUEST_DELAY_MIN_MS;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchThreadMessages(
  threadId: string,
  threadTitle: string,
  username: string,
): Promise<MessageFull[]> {
  const result = await runInstagramCliAsync(
    ["read", threadId, "-o", "json", "-u", username, "--limit", String(THREAD_MESSAGE_LIMIT)],
    CLI_TIMEOUT_MS,
  );

  if (!result.ok) {
    console.error(`[instagram] Failed to read thread ${threadId}: ${result.stderr || `exit ${result.exitCode}`}`);
    return [];
  }

  const parsed = parseCliJson<ReadResult>(result.stdout);
  if (!parsed.ok || !parsed.data?.messages) {
    console.error(`[instagram] Failed to parse thread ${threadId}: ${parsed.error ?? "no messages"}`);
    return [];
  }

  return parsed.data.messages.map((msg) =>
    readMessageToFull(msg, threadId, threadTitle),
  );
}

export async function fetchInstagramInbox(username: string): Promise<void> {
  const result = await runInstagramCliAsync(
    ["inbox", "-o", "json", "--limit", "20", "-u", username],
    CLI_TIMEOUT_MS,
  );

  if (!result.ok) {
    throw new Error(`instagram-cli inbox failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  }

  const parsed = parseCliJson<InboxThread[]>(result.stdout);
  if (!parsed.ok || !parsed.data) {
    throw new Error(`instagram-cli inbox error: ${parsed.error ?? "unknown"}`);
  }

  const threads = parsed.data;

  const sorted = [...threads].sort(
    (a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
  );

  // Store all thread envelopes so the daemon can read them by thread ID
  const envelopes = threads.map(threadToEnvelope);
  if (envelopes.length > 0) {
    store.upsertMessages(envelopes, "in");
  }

  // Fetch individual messages for most-active threads (grouped under thread ID)
  // Delay between inbox fetch and thread reads to avoid burst patterns
  for (const thread of sorted.slice(0, MAX_THREADS_PER_SYNC)) {
    await randomDelay();
    const messages = await fetchThreadMessages(thread.id, thread.title, username);
    if (messages.length > 0) {
      const incoming = messages.filter((m) => m.from?.address !== "me");
      const outgoing = messages.filter((m) => m.from?.address === "me");
      if (incoming.length > 0) store.upsertFullMessages(incoming, "in", thread.id);
      if (outgoing.length > 0) store.upsertFullMessages(outgoing, "out", thread.id);
    }
  }

  store.recordFetch("instagram", username);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const instagramProvider: MessagingProvider = {
  name: "instagram",
  displayName: "Instagram (instagram-cli)",

  isConfigured() {
    return cliExists(CLI) && resolveSettings() !== null;
  },

  async authenticate(_opts) {
    if (!cliExists(CLI)) {
      console.log(`  instagram-cli not found. Install: npm install -g @i7m/instagram-cli\n`);
      return;
    }
    console.log("  Launching instagram-cli auth login...\n");
    const proc = Bun.spawnSync([CLI, "auth", "login"], {
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    if (proc.exitCode === 0) {
      const { getConfigPath } = await import("../config.ts");
      const configPath = getConfigPath();
      console.log(`\n  Instagram authenticated.\n`);
      console.log(`  Add your username to ${configPath}:\n`);
      console.log(`    { "instagram": { "username": "YOUR_USERNAME" } }\n`);
    } else {
      console.log(`\n  Instagram auth failed or was cancelled.\n`);
    }
  },

  async send(recipientId, body, opts) {
    const settings = resolveSettings(opts?.providerFlags);
    if (!settings) {
      return { ok: false, provider: "instagram", recipientId, error: "Instagram not configured. Run: onemessage auth instagram" };
    }

    if (!cliExists(CLI)) {
      return { ok: false, provider: "instagram", recipientId, error: "instagram-cli not found. Install: npm install -g @i7m/instagram-cli" };
    }

    const result = runInstagramCli([
      "send", recipientId, "--text", body, "-o", "json", "-u", settings.username,
    ]);

    if (!result.ok) {
      return {
        ok: false,
        provider: "instagram",
        recipientId,
        error: result.stderr || result.stdout || `Exit code ${result.exitCode}`,
      };
    }

    const parsed = parseCliJson<SendResult>(result.stdout);
    if (!parsed.ok || !parsed.data) {
      return { ok: false, provider: "instagram", recipientId, error: parsed.error ?? "Send failed" };
    }

    const messageId = parsed.data.messageId ?? String(Date.now());
    cacheSentMessage({
      provider: "instagram",
      messageId,
      fromAddress: settings.username,
      recipientId,
      body,
    });

    return { ok: true, provider: "instagram", recipientId, messageId };
  },

  async inbox(opts) {
    const settings = resolveSettings(opts?.providerFlags);
    if (!settings) {
      console.error("Instagram not configured. Run: onemessage auth instagram");
      return [];
    }

    if (store.isFresh("instagram", 300_000, settings.username) && !opts?.fresh) {
      return store.getCachedInbox("instagram", {
        limit: opts?.limit,
        unread: opts?.unread,
        since: opts?.since,
        from: opts?.from,
      });
    }

    try {
      await fetchInstagramInbox(settings.username);
    } catch (err) {
      console.error(`[instagram] Failed to fetch inbox: ${err instanceof Error ? err.message : err}`);
    }

    return store.getCachedInbox("instagram", {
      limit: opts?.limit,
      unread: opts?.unread,
      since: opts?.since,
      from: opts?.from,
    });
  },

  async read(messageId, _opts) {
    return readFromCacheOrFail("instagram", messageId);
  },

  async search(query, opts) {
    return store.searchCached(query, "instagram", {
      limit: opts?.limit,
      since: opts?.since,
    });
  },
};

registerProvider(instagramProvider);
