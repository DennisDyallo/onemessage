/**
 * Shared utilities for messaging providers.
 *
 * Extracted from patterns duplicated across 3+ providers:
 *   - CLI binary existence check (signal, sms — and future telegram, whatsapp)
 *   - Subprocess runner with stderr filtering (signal, sms)
 *   - Cache-only read fallback (signal, sms)
 *   - Outbound message envelope creation (signal, sms)
 */

import { daemonRequest, ensureDaemon } from "../daemons/shared.ts";
import type { GetCachedInboxArgs } from "../store.ts";
import * as store from "../store.ts";
import type { MessageEnvelope, MessageFull } from "../types.ts";

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
  fromAddress: string;
  recipientId: string;
  body: string;
  hasAttachments?: boolean;
}): void {
  const envelope: MessageEnvelope = {
    id: opts.messageId ?? String(Date.now()),
    provider: opts.provider,
    from: { name: "", address: opts.fromAddress },
    to: [{ name: "", address: opts.recipientId }],
    preview: opts.body.slice(0, 100),
    date:
      opts.messageId && /^\d+$/.test(opts.messageId)
        ? new Date(Number(opts.messageId)).toISOString()
        : new Date().toISOString(),
    unread: false,
    hasAttachments: opts.hasAttachments ?? false,
  };
  store.upsertMessages([envelope], "out");
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
