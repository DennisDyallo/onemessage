import { registerProvider } from "../registry.ts";
import { loadConfig } from "../config.ts";
import * as store from "../store.ts";
import { cliExists, runCli, readFromCacheOrFail, cacheSentMessage } from "./shared.ts";
import type { MessagingProvider, MessageFull } from "../types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SignalSettings {
  account: string;
}

function resolveSettings(cliOverrides?: Record<string, unknown>): SignalSettings | null {
  const config = loadConfig();
  const signal = config.signal;

  const account = (cliOverrides?.phone as string) ?? signal?.phone;
  if (!account) return null;

  return { account };
}

/** stderr noise filters for signal-cli */
const SIGNAL_STDERR_FILTERS = [
  (line: string) => line.startsWith("INFO"),
  (line: string) => line.startsWith("WARNING"),
];

function runSignalCli(args: string[], timeoutMs = 30_000) {
  return runCli("signal-cli", args, {
    stderrFilters: SIGNAL_STDERR_FILTERS,
    timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// Group resolution
// ---------------------------------------------------------------------------

interface SignalGroup {
  id: string;
  name: string;
  isMember: boolean;
}

interface GroupCache {
  groups: SignalGroup[];
  account: string;
  timestamp: number;
}

const GROUP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let groupCache: GroupCache | null = null;

function isBase64GroupId(value: string): boolean {
  return value.length > 20 && /[=\/+]/.test(value);
}

function fetchGroups(account: string): SignalGroup[] {
  // Return cached if fresh and same account
  if (
    groupCache &&
    groupCache.account === account &&
    Date.now() - groupCache.timestamp < GROUP_CACHE_TTL_MS
  ) {
    return groupCache.groups;
  }

  const result = runSignalCli(["-a", account, "-o", "json", "listGroups"]);
  if (!result.ok) {
    throw new Error(
      `Failed to list Signal groups: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Failed to parse Signal group list: ${result.stdout.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Expected JSON array from signal-cli listGroups");
  }

  const groups: SignalGroup[] = (parsed as any[])
    .filter((g) => g && typeof g.id === "string" && typeof g.name === "string")
    .map((g) => ({ id: g.id as string, name: g.name as string, isMember: !!g.isMember }));

  groupCache = { groups, account, timestamp: Date.now() };
  return groups;
}

function resolveGroupId(name: string, account: string): string {
  const groups = fetchGroups(account);
  const memberGroups = groups.filter((g) => g.isMember);
  const needle = name.toLowerCase();
  const matches = memberGroups.filter((g) => g.name.toLowerCase().includes(needle));

  if (matches.length === 0) {
    const available = memberGroups.map((g) => `  - ${g.name}`).join("\n");
    throw new Error(
      `No Signal group matching "${name}".\nAvailable groups:\n${available || "  (none)"}`,
    );
  }

  if (matches.length > 1) {
    const ambiguous = matches.map((g) => `  - ${g.name}`).join("\n");
    throw new Error(
      `Ambiguous group name "${name}" — ${matches.length} matches:\n${ambiguous}`,
    );
  }

  return matches[0]!.id;
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

interface SignalJsonMessage {
  envelope?: {
    source?: string;
    sourceName?: string;
    sourceNumber?: string;
    timestamp?: number;
    dataMessage?: {
      timestamp?: number;
      message?: string;
      groupInfo?: { groupId?: string };
      attachments?: {
        contentType?: string;
        filename?: string;
        size?: number;
      }[];
    };
    syncMessage?: {
      sentMessage?: {
        timestamp?: number;
        message?: string;
        destination?: string;
        destinationNumber?: string;
        attachments?: any[];
      };
    };
  };
}

function parseSignalMessages(jsonLines: string): MessageFull[] {
  const messages: MessageFull[] = [];

  for (const line of jsonLines.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: SignalJsonMessage = JSON.parse(line);
      const env = parsed.envelope;
      if (!env) continue;

      const dataMsg = env.dataMessage;
      const syncMsg = env.syncMessage?.sentMessage;

      if (!dataMsg && !syncMsg) continue;

      const content = dataMsg?.message ?? syncMsg?.message ?? "";
      const timestamp = dataMsg?.timestamp ?? syncMsg?.timestamp ?? env.timestamp ?? 0;
      const source = env.sourceNumber ?? env.source ?? "";
      const sourceName = env.sourceName ?? "";
      const hasAttachments =
        (dataMsg?.attachments?.length ?? 0) > 0 ||
        (syncMsg?.attachments?.length ?? 0) > 0;

      messages.push({
        id: String(timestamp),
        provider: "signal",
        from: { name: sourceName, address: source },
        to: syncMsg?.destinationNumber
          ? [{ name: "", address: syncMsg.destinationNumber }]
          : [],
        preview: content.slice(0, 100),
        body: content,
        bodyFormat: "text",
        attachments: [],
        date: timestamp ? new Date(timestamp).toISOString() : "",
        unread: true,
        hasAttachments,
      });
    } catch {
      // Skip unparseable lines
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const signalProvider: MessagingProvider = {
  name: "signal",
  displayName: "Signal (signal-cli)",

  isConfigured() {
    return cliExists("signal-cli") && resolveSettings() !== null;
  },

  async send(recipientId, body, opts) {
    const settings = resolveSettings(opts?.providerFlags);
    if (!settings) {
      return { ok: false, provider: "signal", recipientId, error: "Signal not configured. Run: onemessage auth signal" };
    }

    if (!cliExists("signal-cli")) {
      return { ok: false, provider: "signal", recipientId, error: "signal-cli not found. Install: brew install signal-cli" };
    }

    const args = ["-a", settings.account, "send", "-m", body];

    if (opts?.attachments && opts.attachments.length > 0) {
      for (const att of opts.attachments) {
        args.push("--attachment", att);
      }
    }

    if (recipientId.startsWith("group:")) {
      let groupId = recipientId.slice(6);
      if (!isBase64GroupId(groupId)) {
        try {
          groupId = resolveGroupId(groupId, settings.account);
        } catch (e) {
          return {
            ok: false,
            provider: "signal",
            recipientId,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }
      args.push("-g", groupId);
    } else {
      args.push(recipientId);
    }

    const result = runSignalCli(args);

    if (result.ok) {
      const messageId = result.stdout || undefined;
      if (messageId) {
        cacheSentMessage({
          provider: "signal",
          messageId,
          fromAddress: settings.account,
          recipientId,
          body,
        });
      }
      return { ok: true, provider: "signal", recipientId, messageId };
    } else {
      return { ok: false, provider: "signal", recipientId, error: result.stderr || result.stdout || `Exit code ${result.exitCode}` };
    }
  },

  async inbox(opts) {
    const settings = resolveSettings(opts?.providerFlags);
    if (!settings) {
      console.error("Signal not configured. Run: onemessage auth signal");
      return [];
    }

    if (store.isFresh("signal", 30_000, settings.account) && !opts?.providerFlags?.fresh) {
      return store.getCachedInbox("signal", {
        limit: opts?.limit,
        unread: opts?.unread,
        since: opts?.since,
        from: opts?.from,
      });
    }

    const result = runSignalCli(["-a", settings.account, "-o", "json", "receive", "-t", "5", "--send-read-receipts"]);

    if (result.stdout) {
      const freshMessages = parseSignalMessages(result.stdout);
      if (freshMessages.length > 0) {
        store.upsertFullMessages(freshMessages);
      }
    } else if (!result.ok && result.stderr) {
      process.stderr.write(`[signal] ${result.stderr}\n`);
    }

    store.recordFetch("signal", settings.account);

    return store.getCachedInbox("signal", {
      limit: opts?.limit,
      unread: opts?.unread,
      since: opts?.since,
      from: opts?.from,
    });
  },

  async read(messageId, opts) {
    return readFromCacheOrFail("signal", messageId);
  },

  async search(query, opts) {
    return store.searchCached(query, "signal", {
      limit: opts?.limit,
      since: opts?.since,
    });
  },
};

registerProvider(signalProvider);
