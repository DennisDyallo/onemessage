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
    return convs.map((c) => ({
      id: String(c.thread_id),
      provider: "sms",
      from: c.direction === "in" ? { name: c.contact, address: c.contact } : null,
      to: c.direction === "out" ? [{ name: c.contact, address: c.contact }] : [],
      preview: c.preview.slice(0, 100),
      body: c.preview,
      bodyFormat: "text" as const,
      attachments: [],
      date: c.timestamp,
      unread: !c.read,
      hasAttachments: false,
    }));
  } catch {
    process.stderr.write("[sms] Failed to parse kdeconnect-read-sms output\n");
    return [];
  }
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
      const messages = fetchSmsConversations({
        unread: opts?.unread,
        fresh: opts?.fresh,
        from: opts?.from,
      });

      if (messages.length > 0) {
        store.upsertFullMessages(messages);
      }
      store.recordFetch("sms");
    }

    return store.getCachedInbox("sms", {
      limit: opts?.limit,
      unread: opts?.unread,
      since: opts?.since,
      from: opts?.from,
    });
  },

  async read(messageId, opts) {
    return readFromCacheOrFail("sms", messageId);
  },
};

registerProvider(smsProvider);
