import { registerProvider } from "../registry.ts";
import { loadConfig } from "../config.ts";
import * as store from "../store.ts";
import { cliExists, runCli, runCliAsync, readFromCacheOrFail, cacheSentMessage } from "./shared.ts";
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

function parseSignalMessages(jsonLines: string, account?: string): MessageFull[] {
  const messages: MessageFull[] = [];
  // Build group name lookup from cache (best-effort, may be empty on first run)
  const groupNames = new Map<string, string>();
  try {
    if (account) {
      const groups = fetchGroups(account);
      for (const g of groups) {
        groupNames.set(g.id, g.name);
      }
    }
  } catch {}

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

      // Detect group messages
      const groupId = dataMsg?.groupInfo?.groupId;
      const groupName = groupId ? (groupNames.get(groupId) ?? groupId) : undefined;

      messages.push({
        id: String(timestamp),
        provider: "signal",
        from: groupName
          ? { name: `${sourceName} [${groupName}]`, address: `group:${groupId}` }
          : { name: sourceName, address: source },
        to: syncMsg?.destinationNumber
          ? [{ name: "", address: syncMsg.destinationNumber }]
          : [],
        subject: groupName,
        preview: content.slice(0, 100),
        body: content,
        bodyFormat: "text",
        attachments: [],
        date: timestamp ? new Date(timestamp).toISOString() : "",
        unread: true,
        hasAttachments,
        isGroup: !!groupId,
        groupName,
      });
    } catch {
      // Skip unparseable lines
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Fetch-and-cache (callable by daemon)
// ---------------------------------------------------------------------------

export function fetchSignalInbox(account: string): void {
  const result = runSignalCli(["-a", account, "-o", "json", "receive", "-t", "5", "--send-read-receipts"]);

  if (result.stdout) {
    const freshMessages = parseSignalMessages(result.stdout, account);
    if (freshMessages.length > 0) {
      const incoming = freshMessages.filter((m) => m.from?.address !== account);
      const outgoing = freshMessages.filter((m) => m.from?.address === account);
      if (incoming.length > 0) store.upsertFullMessages(incoming, "in");
      if (outgoing.length > 0) store.upsertFullMessages(outgoing, "out");
      console.error(`[signal] Stored ${incoming.length} in + ${outgoing.length} out messages`);
    }
  } else if (!result.ok && result.stderr) {
    process.stderr.write(`[signal] ${result.stderr}\n`);
  }

  store.recordFetch("signal", account);
}

/**
 * Async version of fetchSignalInbox — does not block the event loop.
 * Used by the daemon so polling Signal doesn't stall other providers.
 */
export async function fetchSignalInboxAsync(account: string): Promise<void> {
  const result = await runCliAsync("signal-cli", ["-a", account, "-o", "json", "receive", "-t", "5", "--send-read-receipts"], {
    stderrFilters: SIGNAL_STDERR_FILTERS,
    timeoutMs: 30_000,
  });

  if (result.stdout) {
    const freshMessages = parseSignalMessages(result.stdout, account);
    if (freshMessages.length > 0) {
      const incoming = freshMessages.filter((m) => m.from?.address !== account);
      const outgoing = freshMessages.filter((m) => m.from?.address === account);
      if (incoming.length > 0) store.upsertFullMessages(incoming, "in");
      if (outgoing.length > 0) store.upsertFullMessages(outgoing, "out");
      console.error(`[signal] Stored ${incoming.length} in + ${outgoing.length} out messages`);
    }
  } else if (!result.ok && result.stderr) {
    process.stderr.write(`[signal] ${result.stderr}\n`);
  }

  store.recordFetch("signal", account);
}

// ---------------------------------------------------------------------------
// Real-time daemon mode (signal-cli daemon --json)
// ---------------------------------------------------------------------------

export interface SignalDaemonHandle {
  /** Kill the subprocess and stop receiving messages */
  stop(): void;
  /** True while the subprocess is running */
  readonly running: boolean;
}

/**
 * Start a persistent signal-cli subprocess in daemon mode.
 * It streams JSON lines to stdout as messages arrive in real-time.
 * Returns a handle to stop the subprocess.
 *
 * Options:
 *   account      — the phone number to use
 *   onMessage    — called for each batch of parsed messages
 *   onError      — called when the subprocess exits or errors
 *   restartDelayMs — delay before restarting after crash (default 5000)
 */
export function startSignalDaemon(opts: {
  account: string;
  onMessage: (messages: MessageFull[]) => void;
  onError?: (error: string) => void;
  restartDelayMs?: number;
}): SignalDaemonHandle {
  const restartDelay = opts.restartDelayMs ?? 5_000;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let stopped = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  function spawn() {
    if (stopped) return;

    process.stderr.write(`[signal-daemon] starting signal-cli daemon for ${opts.account}\n`);

    proc = Bun.spawn(
      ["signal-cli", "-a", opts.account, "-o", "json", "daemon", "--send-read-receipts"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    // Stream stdout line-by-line
    (async () => {
      const stdout = proc?.stdout;
      if (!stdout || typeof stdout === "number") return;
      const reader = stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Process complete lines
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);

            if (!line) continue;
            const messages = parseSignalMessages(line, opts.account);
            if (messages.length > 0) {
              opts.onMessage(messages);
            }
          }
        }
      } catch (err) {
        if (!stopped) {
          process.stderr.write(`[signal-daemon] stdout read error: ${err}\n`);
        }
      }
    })();

    // Drain stderr (filter noise)
    (async () => {
      const stderr = proc?.stderr;
      if (!stderr || typeof stderr === "number") return;
      const reader = stderr.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) continue;
            // Filter out INFO/WARNING noise
            if (SIGNAL_STDERR_FILTERS.some((fn) => fn(line))) continue;
            process.stderr.write(`[signal-daemon] ${line}\n`);
          }
        }
      } catch {
        // ignore
      }
    })();

    // Handle process exit
    proc.exited.then((exitCode) => {
      proc = null;
      if (stopped) return;

      const msg = `signal-cli daemon exited with code ${exitCode}`;
      process.stderr.write(`[signal-daemon] ${msg}, restarting in ${restartDelay}ms\n`);
      opts.onError?.(msg);

      restartTimer = setTimeout(() => {
        restartTimer = null;
        spawn();
      }, restartDelay);
    });
  }

  spawn();

  return {
    stop() {
      stopped = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (proc) {
        proc.kill();
        proc = null;
      }
      process.stderr.write("[signal-daemon] stopped\n");
    },
    get running() {
      return proc !== null;
    },
  };
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

  async authenticate(_opts) {
    console.log("  Linking to Signal...\n");
    const { getConfigPath } = await import("../config.ts");
    const configPath = getConfigPath();
    const proc = Bun.spawnSync(["signal-cli", "link", "-n", "onemessage"], {
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    if (proc.exitCode === 0) {
      console.log("\n  Signal linked successfully.\n");
      console.log(`  Add your phone number to ${configPath}:\n`);
      console.log(`    { "signal": { "phone": "+YOUR_NUMBER" } }\n`);
    } else {
      console.log(`\n  Signal link failed. You can also configure manually:\n`);
      console.log(`    signal-cli link -n "onemessage"\n`);
      console.log(`  Then add to ${configPath}:\n`);
      console.log(`    { "signal": { "phone": "+YOUR_NUMBER" } }\n`);
    }
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

    if (store.isFresh("signal", 30_000, settings.account) && !opts?.fresh) {
      return store.getCachedInbox("signal", {
        limit: opts?.limit,
        unread: opts?.unread,
        since: opts?.since,
        from: opts?.from,
      });
    }

    fetchSignalInbox(settings.account);

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
