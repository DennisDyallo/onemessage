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
const CLI_TIMEOUT_MS = 30_000; // instagram-cli has Node.js startup overhead

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

function threadToFull(thread: InboxThread): MessageFull | null {
  if (!thread.lastMessage) return null;
  const envelope = threadToEnvelope(thread);
  return {
    ...envelope,
    body: thread.lastMessage.text ?? `[${thread.lastMessage.itemType}]`,
    bodyFormat: "text",
    attachments: [],
  };
}

function readMessageToFull(msg: ReadMessage, threadId: string, threadTitle: string): MessageFull {
  return {
    id: msg.id,
    provider: "instagram",
    from: { name: msg.username, address: msg.username },
    to: [{ name: threadTitle, address: threadId }],
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
  const envelopes = threads.map(threadToEnvelope);
  if (envelopes.length > 0) {
    store.upsertMessages(envelopes, "in");
  }

  const fulls = threads.map(threadToFull).filter(Boolean) as MessageFull[];
  if (fulls.length > 0) {
    store.upsertFullMessages(fulls);
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

    if (store.isFresh("instagram", 30_000, settings.username) && !opts?.fresh) {
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
