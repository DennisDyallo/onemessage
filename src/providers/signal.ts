import { registerProvider } from "../registry.ts";
import { loadConfig } from "../config.ts";
import * as store from "../store.ts";
import { cliExists, runCli, readFromCacheOrFail, cacheSentMessage } from "./shared.ts";
import type { MessagingProvider, MessageEnvelope, MessageFull } from "../types.ts";

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
      args.push("-g", recipientId.slice(6));
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

    // Always drain the queue — it's destructive, so we must capture everything
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

    // Return from cache (includes newly drained + all historical messages)
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
