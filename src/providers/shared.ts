/**
 * Shared utilities for messaging providers.
 *
 * Extracted from patterns duplicated across 3+ providers:
 *   - CLI binary existence check (signal, sms — and future telegram, whatsapp)
 *   - Subprocess runner with stderr filtering (signal, sms)
 *   - Cache-only read fallback (signal, sms)
 *   - Outbound message envelope creation (signal, sms)
 */

import { readFileSync } from "node:fs";
import { daemonRequest, ensureDaemon } from "../daemons/shared.ts";
import { getProvider } from "../registry.ts";
import type { GetCachedInboxArgs } from "../store.ts";
import * as store from "../store.ts";
import type {
  MessageEnvelope,
  MessageFull,
  MessagingProvider,
  ReplyOptions,
  SendOptions,
  SendResult,
} from "../types.ts";

export interface ReplyResolution {
  recipientId: string;
  sendOptions?: SendOptions;
}

// ---------------------------------------------------------------------------
// Recipient normalization
// ---------------------------------------------------------------------------

export interface RecipientNormalizationResult {
  ok: boolean;
  recipientId: string;
  error?: string;
}

const PHONE_LIKE_PROVIDERS = new Set(["signal", "sms", "whatsapp"]);

export function normalizePhoneRecipient(recipientId: string): RecipientNormalizationResult {
  const trimmed = recipientId.trim();
  if (!trimmed) {
    return { ok: false, recipientId, error: "Recipient is empty." };
  }

  if (trimmed.startsWith("group:") || trimmed.includes("@")) {
    return { ok: true, recipientId: trimmed };
  }

  const compact = trimmed.replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(compact) && !compact.startsWith("00")) {
    return { ok: true, recipientId: trimmed };
  }

  if (compact.startsWith("+")) {
    return { ok: true, recipientId: `+${compact.slice(1).replace(/\D/g, "")}` };
  }

  if (compact.startsWith("00")) {
    return { ok: true, recipientId: `+${compact.slice(2)}` };
  }

  if (compact.startsWith("46")) {
    return { ok: true, recipientId: `+${compact}` };
  }

  if (/^0[1-9]\d+$/.test(compact)) {
    return { ok: true, recipientId: `+46${compact.slice(1)}` };
  }

  return {
    ok: false,
    recipientId: trimmed,
    error: `Cannot infer country code for "${trimmed}". Use E.164 format, e.g. +46728418689.`,
  };
}

export function normalizeRecipientForProvider(
  provider: string,
  recipientId: string,
): RecipientNormalizationResult {
  if (!PHONE_LIKE_PROVIDERS.has(provider)) return { ok: true, recipientId: recipientId.trim() };
  return normalizePhoneRecipient(recipientId);
}

// ---------------------------------------------------------------------------
// CLI binary check
// ---------------------------------------------------------------------------

const cliCache = new Map<string, boolean>();

/**
 * Check if a CLI binary exists on the system PATH.
 * Results are cached for the lifetime of the process.
 */
export function cliExists(cmd: string): boolean {
  const cached = cliCache.get(cmd);
  if (cached !== undefined) return cached;

  let exists: boolean;
  try {
    exists = Bun.spawnSync(["which", cmd]).exitCode === 0;
  } catch {
    exists = false;
  }
  cliCache.set(cmd, exists);
  return exists;
}

// ---------------------------------------------------------------------------
// Subprocess runner
// ---------------------------------------------------------------------------

export interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunCliOptions {
  /** Lines matching any of these filters are removed from stderr */
  stderrFilters?: ((line: string) => boolean)[];
  /** Timeout in milliseconds (default: 30_000) */
  timeoutMs?: number;
}

/**
 * Run a CLI command, capture output, and optionally filter noisy stderr lines.
 *
 * Used by signal-cli, kdeconnect-cli, and future CLI-based providers.
 */
export function runCli(cmd: string, args: string[], opts?: RunCliOptions): CliResult {
  const result = Bun.spawnSync([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts?.timeoutMs ?? 30_000,
  });

  let stderr = result.stderr.toString();
  if (opts?.stderrFilters && opts.stderrFilters.length > 0) {
    stderr = stderr
      .split("\n")
      .filter((line) => {
        if (!line.trim()) return false;
        return !opts.stderrFilters?.some((fn) => fn(line));
      })
      .join("\n")
      .trim();
  } else {
    stderr = stderr.trim();
  }

  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr,
    exitCode: result.exitCode,
  };
}

/**
 * Async version of runCli — uses Bun.spawn instead of Bun.spawnSync so the
 * event loop is not blocked while waiting for the subprocess to finish.
 */
export async function runCliAsync(
  cmd: string,
  args: string[],
  opts?: RunCliOptions,
): Promise<CliResult> {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Apply timeout manually
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const timer = setTimeout(() => proc.kill(), timeoutMs);

  const [stdoutBuf, stderrBuf] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).arrayBuffer(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const stdoutStr = new TextDecoder().decode(stdoutBuf).trim();
  let stderr = new TextDecoder().decode(stderrBuf);

  if (opts?.stderrFilters && opts.stderrFilters.length > 0) {
    stderr = stderr
      .split("\n")
      .filter((line) => {
        if (!line.trim()) return false;
        return !opts.stderrFilters?.some((fn) => fn(line));
      })
      .join("\n")
      .trim();
  } else {
    stderr = stderr.trim();
  }

  return {
    ok: exitCode === 0,
    stdout: stdoutStr,
    stderr,
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// Cache-only read fallback
// ---------------------------------------------------------------------------

/**
 * Read a message from the local cache. If not found, print a helpful error
 * and return null. Used by providers that have no random-access read API
 * (signal, sms, and likely telegram/whatsapp).
 */
export function readFromCacheOrFail(providerName: string, messageId: string): MessageFull | null {
  const cached = store.getCachedMessage(providerName, messageId);
  if (cached) return cached;

  console.error(`${providerName} message "${messageId}" not found in cache.`);
  console.error(`Run 'onemessage inbox ${providerName}' first to fetch messages.`);
  return null;
}

// ---------------------------------------------------------------------------
// Reply resolution
// ---------------------------------------------------------------------------

export function resolveDefaultReply(original: MessageFull): ReplyResolution {
  const conversationAddress = original.to.find(
    (contact) => contact.address && contact.address !== "me",
  )?.address;
  const recipientId = original.isGroup
    ? ((original.from?.address?.startsWith("group:") ? original.from.address : undefined) ??
      conversationAddress ??
      (original.groupName ? `group:${original.groupName}` : undefined))
    : original.direction === "out"
      ? conversationAddress
      : original.from?.address;
  if (!recipientId) {
    throw new Error("Cannot reply: original message has no sender or conversation address.");
  }

  return { recipientId };
}

export async function replyViaSend(
  provider: MessagingProvider,
  messageId: string,
  body: string,
  opts?: ReplyOptions,
): Promise<SendResult> {
  let finalBody = body;
  if (opts?.file) {
    try {
      finalBody = readFileSync(opts.file, "utf-8");
    } catch (err: unknown) {
      return {
        ok: false,
        provider: provider.name,
        recipientId: "",
        error: `Cannot read "${opts.file}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const original = readFromCacheOrFail(provider.name, messageId);
  if (!original) {
    return {
      ok: false,
      provider: provider.name,
      recipientId: "",
      error: `Message "${messageId}" not found in cache.`,
    };
  }

  let resolution: ReplyResolution;
  try {
    resolution = resolveDefaultReply(original);
  } catch (err: unknown) {
    return {
      ok: false,
      provider: provider.name,
      recipientId: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return provider.send(resolution.recipientId, finalBody, {
    ...opts,
    ...resolution.sendOptions,
    providerFlags: opts?.providerFlags,
  });
}

// ---------------------------------------------------------------------------
// Outbound message envelope
// ---------------------------------------------------------------------------

/**
 * Build a MessageEnvelope for a sent message and upsert it into the cache.
 * Standardizes the post-send cache write that signal, sms (and future
 * providers) all perform.
 */
export function cacheSentMessage(opts: {
  provider: string;
  messageId?: string;
  account?: string;
  fromAddress: string;
  recipientId: string;
  recipientName?: string;
  body: string;
  bodyFormat?: "text" | "html";
  subject?: string;
  hasAttachments?: boolean;
  rfcMessageId?: string;
  replyTo?: { name: string; address: string }[];
  references?: string[];
  threadId?: string;
}): void {
  const message: MessageFull = {
    id: opts.messageId ?? String(Date.now()),
    provider: opts.provider,
    account: opts.account,
    from: { name: "", address: opts.fromAddress },
    to: [{ name: opts.recipientName ?? "", address: opts.recipientId }],
    subject: opts.subject,
    preview: opts.body.slice(0, 100),
    body: opts.body,
    bodyFormat: opts.bodyFormat ?? "text",
    date:
      opts.messageId && /^\d+$/.test(opts.messageId)
        ? new Date(Number(opts.messageId)).toISOString()
        : new Date().toISOString(),
    unread: false,
    hasAttachments: opts.hasAttachments ?? false,
    attachments: [],
    direction: "out",
    ...(opts.rfcMessageId ? { rfcMessageId: opts.rfcMessageId } : {}),
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    ...(opts.references ? { references: opts.references } : {}),
  };
  store.upsertFullMessages([message], opts.threadId);
}

// ---------------------------------------------------------------------------
// Daemon-based inbox
// ---------------------------------------------------------------------------

/**
 * Canonical "cache-first inbox with daemon-owned fetch" convention.
 *
 *   1. If cache for (provider, account) is fresh and !fresh, return cache immediately.
 *   2. Otherwise ensureDaemon() and ask the daemon to perform the fetch via
 *      { type: "fetch", provider } — the daemon owns the external resource,
 *      so this eliminates contention with concurrent CLI invocations.
 *   3. Return cache (now up-to-date if the daemon fetch succeeded).
 *
 * On daemon unavailability (start fails OR IPC errors): log a warning and
 * invoke optional fallbackFetch (for providers that can safely run direct
 * fetch when no daemon owns the resource). Always returns cached inbox —
 * never throws.
 *
 * **IMPORTANT — Freshness keys vs fetch parameters:**
 * The `account` and `folder` parameters are used ONLY as freshness cache keys
 * (via `store.isFresh(provider, freshnessMs, account, folder)`), NOT as parameters
 * to the daemon's fetch. The daemon IPC `{type:"fetch", provider}` passes only
 * `provider` — the daemon adapter's `fetch()` method uses its own hardcoded
 * default parameters. If the caller needs custom folder/criteria/account filtering
 * that differs from what the daemon fetches, the provider MUST bypass this helper
 * and fetch directly. See `src/providers/email.ts` lines 421-435 for the worked
 * example: `isDefaultRequest` checks if the request matches what the daemon can
 * service; non-default requests use manual `isFresh` + direct fetch instead.
 */
export async function inboxViaDaemon(args: {
  provider: string;
  freshnessMs: number;
  account?: string;
  folder?: string;
  fresh?: boolean;
  cacheArgs: GetCachedInboxArgs;
  fallbackFetch?: () => void | Promise<void>;
}): Promise<MessageEnvelope[]> {
  const { provider, freshnessMs, account, folder, fresh, cacheArgs, fallbackFetch } = args;

  if (store.isFresh(provider, freshnessMs, account, folder) && !fresh) {
    return store.getCachedInbox(provider, cacheArgs);
  }

  async function runFallback() {
    if (!fallbackFetch) return;
    try {
      await fallbackFetch();
    } catch (err) {
      console.warn(
        `[${provider}] fallback fetch failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  try {
    if (!getProvider(provider)) {
      console.warn(`[${provider}] daemon fetch error: unknown provider`);
      await runFallback();
      return store.getCachedInbox(provider, cacheArgs);
    }

    await ensureDaemon();
    const res = await daemonRequest({ type: "fetch", provider });
    if (!res?.ok) {
      console.warn(`[${provider}] daemon fetch error: ${res?.error ?? "unknown"}`);
      await runFallback();
    }
  } catch (err) {
    console.warn(`[${provider}] daemon unavailable: ${err instanceof Error ? err.message : err}`);
    await runFallback();
  }

  return store.getCachedInbox(provider, cacheArgs);
}
