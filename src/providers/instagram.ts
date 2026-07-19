import { getProviderFreshnessMs, loadConfig } from "../config.ts";
import { daemonRequest, ensureDaemon } from "../daemons/shared.ts";
import { registerProvider } from "../registry.ts";
import * as store from "../store.ts";
import type { MessageEnvelope, MessageFull, MessagingProvider } from "../types.ts";
import {
  cacheSentMessage,
  cliExists,
  inboxViaDaemon,
  readFromCacheOrFail,
  runCli,
  runCliAsync,
} from "./shared.ts";

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

interface InboxResult {
  threads: InboxThread[];
  hasMore?: boolean;
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
  hasMore?: boolean;
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
    // TODO(dennis): instagram-cli does not expose media download; revisit when
    // upstream adds the command (see distributed-dusk plan §1.4)
    attachments: [],
    direction: msg.isOutgoing ? "out" : "in",
  };
}

// ---------------------------------------------------------------------------
// Fetch and cache (callable by daemon)
// ---------------------------------------------------------------------------

const THREAD_MESSAGE_LIMIT = 20;
const INBOX_THREAD_LIMIT = 100;

export async function fetchThreadMessages(
  threadId: string,
  threadTitle: string,
  username: string,
): Promise<MessageFull[]> {
  const page = await fetchThreadMessagesPage(threadId, threadTitle, username, {
    limit: THREAD_MESSAGE_LIMIT,
  });
  return page.messages;
}

export async function fetchThreadMessagesPage(
  threadId: string,
  threadTitle: string,
  username: string,
  opts?: { cursor?: string; limit?: number },
): Promise<{ messages: MessageFull[]; cursor?: string; hasMore: boolean }> {
  const args = [
    "read",
    threadId,
    "-o",
    "json",
    "-u",
    username,
    "--limit",
    String(opts?.limit ?? THREAD_MESSAGE_LIMIT),
  ];
  if (opts?.cursor) args.push("--cursor", opts.cursor);

  const result = await runInstagramCliAsync(args, CLI_TIMEOUT_MS);

  if (!result.ok) {
    throw new Error(
      `instagram-cli read failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }

  const parsed = parseCliJson<ReadResult>(result.stdout);
  if (!parsed.ok || !parsed.data?.messages) {
    throw new Error(`instagram-cli read error: ${parsed.error ?? "no messages"}`);
  }

  return {
    messages: parsed.data.messages.map((msg) => readMessageToFull(msg, threadId, threadTitle)),
    cursor: parsed.data.cursor,
    hasMore: parsed.data.hasMore ?? Boolean(parsed.data.cursor),
  };
}

export async function fetchInstagramInbox(
  username: string,
  opts?: { pages?: number; limit?: number },
): Promise<MessageEnvelope[]> {
  const result = await runInstagramCliAsync(
    [
      "inbox",
      "-o",
      "json",
      "--limit",
      String(opts?.limit ?? INBOX_THREAD_LIMIT),
      "--pages",
      String(opts?.pages ?? 1),
      "-u",
      username,
    ],
    CLI_TIMEOUT_MS,
  );

  if (!result.ok) {
    throw new Error(
      `instagram-cli inbox failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }

  const parsed = parseCliJson<InboxThread[] | InboxResult>(result.stdout);
  if (!parsed.ok || !parsed.data) {
    throw new Error(`instagram-cli inbox error: ${parsed.error ?? "unknown"}`);
  }

  const threads = Array.isArray(parsed.data) ? parsed.data : parsed.data.threads;

  // Store all thread envelopes so the daemon can read them by thread ID
  const envelopes = threads.map(threadToEnvelope);
  if (envelopes.length > 0) {
    store.upsertMessages(envelopes, "in");
  }

  store.recordFetch("instagram", username);
  return envelopes;
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
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
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
      return {
        ok: false,
        provider: "instagram",
        recipientId,
        error: "Instagram not configured. Run: onemessage auth instagram",
      };
    }

    if (!cliExists(CLI)) {
      return {
        ok: false,
        provider: "instagram",
        recipientId,
        error: "instagram-cli not found. Install: npm install -g @i7m/instagram-cli",
      };
    }

    const result = runInstagramCli([
      "send",
      recipientId,
      "--text",
      body,
      "-o",
      "json",
      "-u",
      settings.username,
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
      return {
        ok: false,
        provider: "instagram",
        recipientId,
        error: parsed.error ?? "Send failed",
      };
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
    return inboxViaDaemon({
      provider: "instagram",
      freshnessMs: getProviderFreshnessMs("instagram"),
      account: settings.username,
      fresh: opts?.fresh,
      cacheArgs: {
        limit: opts?.limit,
        unread: opts?.unread,
        since: opts?.since,
        sinceCachedAt: opts?.sinceCachedAt,
        from: opts?.from,
      },
    });
  },

  async read(messageId, opts) {
    if (opts?.fresh) {
      const settings = resolveSettings(opts?.providerFlags);
      if (!settings) {
        console.error("Instagram not configured. Run: onemessage auth instagram");
        return null;
      }
      // Route thread re-fetch through daemon to enforce MIN_FETCH_INTERVAL_MS guard.
      // Use the messageId as thread ID — Instagram thread IDs are the same as
      // the envelope IDs stored in the DB.
      await ensureDaemon();
      const res = await daemonRequest({
        type: "fetch-thread",
        provider: "instagram",
        threadId: messageId,
        account: settings.username,
      });
      if (!res.ok) {
        console.error(`[instagram] thread re-fetch failed: ${res.error}`);
      }
    }
    return readFromCacheOrFail("instagram", messageId);
  },

  async search(query, opts) {
    return store.searchCached(query, "instagram", {
      limit: opts?.limit,
      since: opts?.since,
    });
  },
};

export { instagramProvider };

registerProvider(instagramProvider);
