import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { getConfigDir, getProviderFreshnessMs, loadConfig } from "../config.ts";
import { isProcessAlive } from "../daemons/shared.ts";
import { registerProvider } from "../registry.ts";
import { getSignalAttachmentDir } from "../shared/attachment-paths.ts";
import { validateAttachment } from "../shared/attachment-validation.ts";
import { constructSafeSignalAttachmentPathWithReason } from "../shared/signal-attachment-security.ts";
import * as store from "../store.ts";
import type { Attachment, MessageFull, MessagingProvider } from "../types.ts";
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

export function getSignalJsonRpcSocketPath(): string {
  return join(getConfigDir(), "signal-cli.sock");
}

// ---------------------------------------------------------------------------
// Signal-cli child reconciliation (stale-socket resilience)
//
// macOS lsof cannot attribute a UNIX socket by path, so liveness is decided by
// a tri-state connect probe and ownership by a PID-file token written only once
// our spawned child has actually bound the socket. See
// Plans/playful-meandering-lighthouse.md §2 for the full design + audit trail.
// ---------------------------------------------------------------------------

/** PID-file token: the only proof that a live signal-cli child is *ours*. */
export function getSignalPidFilePath(): string {
  return join(getConfigDir(), "signal-cli.pid");
}

export function readSignalChildPid(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(getSignalPidFilePath(), "utf-8").trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function writeSignalChildPid(pid: number): void {
  writeFileSync(getSignalPidFilePath(), String(pid));
}

/** Compare-and-clear: only unlink the token if it still holds `expectedPid`, so a
 *  stale exit handler can never erase a newer child's token. */
export function clearSignalChildPid(expectedPid?: number): void {
  try {
    if (expectedPid !== undefined && readSignalChildPid() !== expectedPid) return;
    unlinkSync(getSignalPidFilePath());
  } catch {
    // ignore — already gone or unwritable
  }
}

export type SignalLiveness = "accepting" | "dead" | "uncertain";

/**
 * Tri-state connect probe — the sole authority on whether anyone is listening.
 * "dead" (absent / ECONNREFUSED / ENOENT) is definitive ⇒ safe to unlink.
 * "uncertain" (timeout / other error) ⇒ never unlink, back off.
 */
export function probeSignalSocket(
  socketPath = getSignalJsonRpcSocketPath(),
  timeoutMs = 500,
): Promise<SignalLiveness> {
  return new Promise((resolve) => {
    if (!existsSync(socketPath)) return resolve("dead");
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const sock = connect(socketPath);
    const done = (r: SignalLiveness) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {}
      resolve(r);
    };
    timer = setTimeout(() => done("uncertain"), timeoutMs);
    sock.once("connect", () => done("accepting"));
    sock.once("error", (e: NodeJS.ErrnoException) =>
      done(e.code === "ECONNREFUSED" || e.code === "ENOENT" ? "dead" : "uncertain"),
    );
  });
}

function psField(pid: number, field: string): string | null {
  try {
    const r = Bun.spawnSync(["ps", "-ww", "-p", String(pid), "-o", `${field}=`]);
    if (r.exitCode !== 0) return null;
    const out = r.stdout.toString().trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** ~2s tolerance for `ps -o lstart=` second-granularity vs token mtime. */
const SIGNAL_LSTART_SKEW_MS = 2_000;

/**
 * True iff `pid` is alive AND a signal-cli for `account` AND started no later
 * than our PID-token's mtime (the start-time guard closes PID reuse). Biased
 * toward `false` (a wrong kill is worse than a recoverable "not ours").
 */
export function isSignalCliForAccount(pid: number, account: string): boolean {
  if (!isProcessAlive(pid)) return false;
  const command = psField(pid, "command");
  if (!command) return false;
  const tokens = command.split(/\s+/);
  const isSignalCli = tokens.some((t) => /(^|\/)signal-cli$/.test(t));
  if (!isSignalCli || !tokens.includes(account)) return false;
  try {
    const lstart = psField(pid, "lstart");
    if (!lstart) return false;
    const started = new Date(lstart).getTime();
    if (Number.isNaN(started)) return false;
    const tokenMtime = statSync(getSignalPidFilePath()).mtimeMs;
    return started <= tokenMtime + SIGNAL_LSTART_SKEW_MS;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isProcessAlive(pid);
}

/**
 * Reap a confirmed-ours orphan: re-check identity before each kill, confirm the
 * process exited, then unlink only once the socket probes "dead".
 */
export async function reapSignalOrphan(
  pid: number,
  account: string,
  socketPath: string,
  isOurs: (p: number, a: string) => boolean = isSignalCliForAccount,
  probe: (path?: string, timeoutMs?: number) => Promise<SignalLiveness> = probeSignalSocket,
  kill: (p: number, sig?: number) => void = (p, sig) => process.kill(p, sig),
  waitExit: (p: number, t: number) => Promise<boolean> = waitForPidExit,
): Promise<boolean> {
  if (!isOurs(pid, account)) return false; // recycled / changed since check → abort
  try {
    kill(pid);
  } catch {}
  let exited = await waitExit(pid, 3_000);
  if (!exited) {
    if (isOurs(pid, account)) {
      try {
        kill(pid, 9);
      } catch {}
    }
    exited = await waitExit(pid, 2_000);
  }
  if (!exited) return false; // won't die → do NOT unlink, caller backs off
  if ((await probe(socketPath)) !== "dead") return false; // replacement listener / uncertain → keep
  try {
    unlinkSync(socketPath);
  } catch {}
  if (existsSync(socketPath)) return false; // unlink failed → don't claim clear (avoid bind loop)
  return true;
}

export type SignalReclaimResult = "clear" | "busy";

/**
 * Make the socket path bindable without ever duplicating the daemon. Returns
 * "clear" (spawn) or "busy" (a live listener we don't own, or uncertainty —
 * back off). Runs under the unified-daemon parent singleton, so a live token
 * child here is always the previous (dead) parent's orphan.
 */
export async function reclaimSignalSocket(
  account: string,
  socketPath = getSignalJsonRpcSocketPath(),
  probe: (path?: string, timeoutMs?: number) => Promise<SignalLiveness> = probeSignalSocket,
  isOurs: (p: number, a: string) => boolean = isSignalCliForAccount,
  recordedPid: () => number | null = readSignalChildPid,
  reap: typeof reapSignalOrphan = reapSignalOrphan,
): Promise<SignalReclaimResult> {
  // STEP 1: a live recorded child of ours must be reaped first, regardless of
  // socket state — a live child keeps processing even if its socket vanished, so
  // spawning a second one would duplicate the daemon.
  const mine = recordedPid();
  if (mine !== null && isOurs(mine, account)) {
    const reaped = await reap(mine, account, socketPath, isOurs, probe);
    return reaped ? "clear" : "busy";
  }

  // STEP 2: no live child of ours — handle the socket file.
  if (!existsSync(socketPath)) return "clear";
  const live = await probe(socketPath);
  if (live === "uncertain") return "busy"; // can't be sure → never clobber
  if (live === "accepting") {
    process.stderr.write(
      `[signal-daemon] socket has a live listener that is not ours (token=${mine}); refusing\n`,
    );
    return "busy";
  }
  // live === "dead": file present but no listener → stale stub
  try {
    unlinkSync(socketPath);
  } catch {}
  return existsSync(socketPath) ? "busy" : "clear"; // unlink failed (perms) → don't bind into a loop
}

type SignalSendPhase = "preTransmit" | "postTransmit";

/** Send failure tagged by phase: preTransmit ⇒ provably never sent (safe to
 *  retry/fallback); postTransmit ⇒ delivery unknown (surface, never auto-resend). */
export class SignalSendError extends Error {
  phase: SignalSendPhase;
  constructor(message: string, phase: SignalSendPhase) {
    super(message);
    this.name = "SignalSendError";
    this.phase = phase;
  }
}

interface SignalJsonRpcSendResult {
  timestamp?: number;
  results?: Array<{ type?: string }>;
}

async function signalJsonRpcSend(params: Record<string, unknown>): Promise<string> {
  const socketPath = getSignalJsonRpcSocketPath();
  const id = `onemessage-${Date.now()}`;
  const req = {
    jsonrpc: "2.0",
    method: "send",
    params,
    id,
  };

  const resp = await new Promise<Record<string, unknown>>((resolve, reject) => {
    // `wrote` flips immediately before the first write — failures while false are
    // preTransmit (nothing left the process), everything after is postTransmit.
    let wrote = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    const socket = connect(socketPath, () => {
      wrote = true;
      socket.write(`${JSON.stringify(req)}\n`);
    });

    let data = "";
    timeout = setTimeout(() => {
      socket.destroy();
      finish(() =>
        reject(new SignalSendError("signal-cli JSON-RPC request timed out", "postTransmit")),
      );
    }, 30_000);

    socket.on("data", (chunk) => {
      data += chunk.toString();
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.id === id) {
            socket.end();
            finish(() => resolve(parsed));
            return;
          }
        } catch {
          // Keep reading until a complete JSON-RPC response arrives.
        }
      }
    });

    socket.on("end", () => {
      finish(() =>
        reject(
          new SignalSendError(
            `signal-cli JSON-RPC socket ended without response: ${data.slice(0, 200)}`,
            wrote ? "postTransmit" : "preTransmit",
          ),
        ),
      );
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(new SignalSendError(err.message, wrote ? "postTransmit" : "preTransmit")),
      );
    });
  });

  const err = resp.error as { message?: string } | undefined;
  if (err) throw new SignalSendError(err.message ?? JSON.stringify(err), "postTransmit");

  const result = resp.result as SignalJsonRpcSendResult | undefined;
  const failed = result?.results?.find((r) => r.type && r.type !== "SUCCESS");
  if (failed)
    throw new SignalSendError(`signal-cli JSON-RPC send failed: ${failed.type}`, "postTransmit");

  return result?.timestamp ? String(result.timestamp) : "";
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
  return value.length > 20 && /[=/+]/.test(value);
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

  const groups: SignalGroup[] = (parsed as unknown[])
    .filter(
      (g): g is { id: string; name: string; isMember?: boolean } =>
        !!g &&
        typeof (g as Record<string, unknown>).id === "string" &&
        typeof (g as Record<string, unknown>).name === "string",
    )
    .map((g) => ({ id: g.id, name: g.name, isMember: !!g.isMember }));

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
    throw new Error(`Ambiguous group name "${name}" — ${matches.length} matches:\n${ambiguous}`);
  }

  return matches[0]?.id ?? "";
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
        id?: string;
      }[];
    };
    syncMessage?: {
      sentMessage?: {
        timestamp?: number;
        message?: string;
        destination?: string;
        destinationNumber?: string;
        attachments?: {
          contentType?: string;
          filename?: string;
          size?: number;
          id?: string;
        }[];
      };
    };
  };
}

export function parseSignalMessages(jsonLines: string, account?: string): MessageFull[] {
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

  // Build contact name lookup from incoming messages (for enriching outgoing `to` names)
  const contactNames = store.getContactNamesByAddress("signal");

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
        (dataMsg?.attachments?.length ?? 0) > 0 || (syncMsg?.attachments?.length ?? 0) > 0;

      // Detect group messages
      const groupId = dataMsg?.groupInfo?.groupId;
      const groupName = groupId ? (groupNames.get(groupId) ?? groupId) : undefined;

      // Parse attachment metadata (filename, size, type, id)
      // Note: path is NOT populated here — it's added during read() when --attachments is requested
      // Prefer whichever side has content. `??` would pick dataMsg.attachments even if empty,
      // which would drop attachments that only appear in syncMessage (e.g. quote-with-attachment
      // edge cases where both data and sync are present but only one carries the bytes).
      const rawAttachments =
        (dataMsg?.attachments?.length ?? 0) > 0
          ? (dataMsg?.attachments ?? [])
          : (syncMsg?.attachments ?? []);
      const attachments = rawAttachments.map((att) => ({
        filename: att.filename ?? "unknown",
        contentType: att.contentType ?? "application/octet-stream",
        size: att.size ?? 0,
        // Store the id so read() can construct the path later
        ...(att.id ? { id: att.id } : {}),
      }));

      // NOTE: isSync is unreliable for direction — DataMessages from own
      // account have isSync=false but are outgoing. processSignalMessages
      // overrides direction based on from.address vs account before upserting.
      const isSync = !!syncMsg;
      messages.push({
        id: String(timestamp),
        provider: "signal",
        from: groupName
          ? { name: `${sourceName} [${groupName}]`, address: `group:${groupId}` }
          : { name: sourceName, address: source },
        to: syncMsg?.destinationNumber
          ? [
              {
                name: contactNames.get(syncMsg.destinationNumber) ?? "",
                address: syncMsg.destinationNumber,
              },
            ]
          : [],
        subject: groupName,
        preview: content.slice(0, 100),
        body: content,
        bodyFormat: "text",
        attachments: attachments as Attachment[],
        date: timestamp ? new Date(timestamp).toISOString() : "",
        unread: true,
        hasAttachments,
        isGroup: !!groupId,
        groupName,
        direction: isSync ? "out" : "in",
      });
    } catch {
      // Skip unparseable lines
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Shared post-parse processing — split, fix direction, upsert
// ---------------------------------------------------------------------------

/**
 * Process parsed Signal messages: split by direction, fix direction field,
 * and upsert to the store. This is the single source of truth for Signal
 * message processing — used by fetchSignalInboxAsync and the daemon's
 * onMessage callback.
 *
 * Why this exists: parseSignalMessages sets direction based on isSync, but
 * DataMessages from the user's own account arrive as "in" even though they
 * are outgoing. The direction split by account address is the authoritative
 * source, so we override msg.direction before upsert.
 */
export function processSignalMessages(
  messages: MessageFull[],
  account: string,
): { incoming: number; outgoing: number } {
  if (messages.length === 0) return { incoming: 0, outgoing: 0 };

  const incoming = messages.filter((m) => m.from?.address !== account);
  const outgoing = messages.filter((m) => m.from?.address === account);

  // Fix direction for outgoing messages that parseSignalMessages tagged as "in"
  for (const m of outgoing) m.direction = "out";

  if (incoming.length > 0) store.upsertFullMessages(incoming);
  if (outgoing.length > 0) store.upsertFullMessages(outgoing);

  return { incoming: incoming.length, outgoing: outgoing.length };
}

// ---------------------------------------------------------------------------
// Fetch-and-cache (callable by daemon)
// ---------------------------------------------------------------------------

/**
 * Async fetch — does not block the event loop.
 * Used by the daemon so polling Signal doesn't stall other providers.
 */
export async function fetchSignalInboxAsync(account: string): Promise<void> {
  const result = await runCliAsync(
    "signal-cli",
    ["-a", account, "-o", "json", "receive", "-t", "5", "--send-read-receipts"],
    {
      stderrFilters: SIGNAL_STDERR_FILTERS,
      timeoutMs: 30_000,
    },
  );

  if (result.stdout) {
    const freshMessages = parseSignalMessages(result.stdout, account);
    const { incoming, outgoing } = processSignalMessages(freshMessages, account);
    if (incoming + outgoing > 0) {
      console.error(`[signal] Stored ${incoming} in + ${outgoing} out messages`);
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
  /** Lifecycle state — "blocked" when the socket is held by a process we don't own */
  readonly status: "starting" | "running" | "blocked" | "stopped";
}

/**
 * Builds signal-cli daemon spawn arguments.
 * Exported for testing.
 */
export function buildSignalDaemonArgs(account: string): string[] {
  return [
    "signal-cli",
    "-a",
    account,
    "-o",
    "json",
    "daemon",
    "--send-read-receipts",
    "--socket",
    getSignalJsonRpcSocketPath(),
  ];
}

const SIGNAL_MAX_BUSY_RETRIES = 6;
const SIGNAL_READY_TIMEOUT_MS = 10_000;

/** Kill a spawned child and confirm it died (SIGTERM → SIGKILL escalation). */
async function killAndConfirm(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 3_000,
): Promise<void> {
  try {
    proc.kill();
  } catch {}
  const exited = await Promise.race([
    proc.exited.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
  ]);
  if (!exited) {
    try {
      proc.kill(9);
    } catch {}
    await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 1_000))]);
  }
}

/**
 * Resolve true only once OUR child holds the socket bind. Polls the connect
 * probe while racing `proc.exited`; a short grace re-check rules out the window
 * where a foreign listener accepts while our child is still alive pre-exit
 * (signal-cli exits on bind failure, so a lost race makes our child exit).
 */
async function waitForChildBound(
  proc: ReturnType<typeof Bun.spawn>,
  socketPath: string,
  timeoutMs: number,
): Promise<boolean> {
  let alive = true;
  proc.exited.then(() => {
    alive = false;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive) return false;
    if ((await probeSignalSocket(socketPath)) === "accepting") {
      await new Promise((r) => setTimeout(r, 150)); // grace
      return alive; // still alive after grace ⇒ our child won the exclusive bind
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
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
  const socketPath = getSignalJsonRpcSocketPath();
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let stopped = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let busyRetries = 0;
  let status: SignalDaemonHandle["status"] = "starting";

  function scheduleRestart(delay = restartDelay) {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void spawn();
    }, delay);
  }

  // Attach stdout/stderr line readers to a freshly-spawned, ready child.
  function attachReaders(child: ReturnType<typeof Bun.spawn>) {
    // Stream stdout line-by-line
    (async () => {
      const stdout = child.stdout;
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
          for (
            let newlineIdx = buffer.indexOf("\n");
            newlineIdx !== -1;
            newlineIdx = buffer.indexOf("\n")
          ) {
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
      const stderr = child.stderr;
      if (!stderr || typeof stderr === "number") return;
      const reader = stderr.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          for (
            let newlineIdx = buffer.indexOf("\n");
            newlineIdx !== -1;
            newlineIdx = buffer.indexOf("\n")
          ) {
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
  }

  async function spawn() {
    if (stopped) return;
    status = "starting";

    // B1: reconcile the socket before binding (reaps a live ours-orphan first).
    const reclaim = await reclaimSignalSocket(opts.account, socketPath);
    if (stopped) return;
    if (reclaim === "busy") {
      busyRetries++;
      if (busyRetries >= SIGNAL_MAX_BUSY_RETRIES) {
        status = "blocked";
        opts.onError?.(
          `signal socket ${socketPath} is held by a process that is not ours; refusing to start a duplicate — resolve manually (see daemon.log)`,
        );
      }
      process.stderr.write(`[signal-daemon] socket busy (retry ${busyRetries}); backing off\n`);
      scheduleRestart();
      return;
    }
    busyRetries = 0;

    process.stderr.write(`[signal-daemon] starting signal-cli daemon for ${opts.account}\n`);

    // B3: a synchronous Bun.spawn throw must reschedule, not kill the loop.
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(buildSignalDaemonArgs(opts.account), {
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      proc = null;
      opts.onError?.(`signal-cli spawn failed: ${err}`);
      scheduleRestart();
      return;
    }
    proc = child;
    const childPid = child.pid;

    // Write the token ONLY after our child actually holds the bind, so
    // "token-alive + accepting ⇒ ours" holds for the send gate.
    const ready = await waitForChildBound(child, socketPath, SIGNAL_READY_TIMEOUT_MS);
    if (stopped) {
      await killAndConfirm(child);
      proc = null;
      clearSignalChildPid(childPid);
      return;
    }
    if (!ready) {
      await killAndConfirm(child);
      proc = null;
      opts.onError?.("signal-cli did not bind its socket; will retry");
      scheduleRestart();
      return;
    }
    try {
      writeSignalChildPid(childPid);
    } catch (err) {
      await killAndConfirm(child);
      proc = null;
      opts.onError?.(`failed to record signal-cli pid, killed child: ${err}`);
      scheduleRestart();
      return;
    }
    if (stopped) {
      await killAndConfirm(child);
      proc = null;
      clearSignalChildPid(childPid);
      return;
    }

    status = "running";
    attachReaders(child);

    // Handle process exit — compare-and-clear the token, then reschedule.
    child.exited.then((exitCode) => {
      if (proc === child) proc = null;
      clearSignalChildPid(childPid);
      if (stopped) return;

      const msg = `signal-cli daemon exited with code ${exitCode}`;
      process.stderr.write(`[signal-daemon] ${msg}, restarting in ${restartDelay}ms\n`);
      opts.onError?.(msg);
      scheduleRestart();
    });
  }

  void spawn();

  return {
    stop() {
      stopped = true;
      status = "stopped";
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      // We hold the actual Bun.Subprocess handle, so killing it is unambiguous
      // (no foreign-PID risk). Compare-and-clear the token afterward.
      const child = proc;
      const pid = child?.pid;
      if (child) {
        try {
          child.kill();
        } catch {}
        proc = null;
      }
      if (pid !== undefined) clearSignalChildPid(pid);
      process.stderr.write("[signal-daemon] stopped\n");
    },
    get running() {
      return proc !== null;
    },
    get status() {
      return status;
    },
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const signalProvider: MessagingProvider = {
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
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
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
      return {
        ok: false,
        provider: "signal",
        recipientId,
        error: "Signal not configured. Run: onemessage auth signal",
      };
    }

    if (!cliExists("signal-cli")) {
      return {
        ok: false,
        provider: "signal",
        recipientId,
        error: "signal-cli not found. Install: brew install signal-cli",
      };
    }

    const jsonRpcParams: Record<string, unknown> = { message: body };
    const args = ["-a", settings.account, "send", "-m", body];

    if (opts?.attachments && opts.attachments.length > 0) {
      jsonRpcParams.attachments = opts.attachments;
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
      jsonRpcParams.groupId = groupId;
      args.push("-g", groupId);
    } else if (recipientId === settings.account) {
      jsonRpcParams.noteToSelf = true;
      args.push("--note-to-self");
    } else {
      jsonRpcParams.recipient = [recipientId];
      args.push(recipientId);
    }

    // B2: use the JSON-RPC fast path ONLY when we own the live listener. The
    // socket path is a singleton; a foreign same-account-or-not daemon could be
    // bound to it, so sending blindly over it risks a wrong-account send. The
    // token + identity prove ownership; the probe proves liveness.
    const tokenPid = readSignalChildPid();
    const weOwnIt =
      tokenPid !== null &&
      isSignalCliForAccount(tokenPid, settings.account) &&
      (await probeSignalSocket()) === "accepting";

    if (weOwnIt) {
      try {
        const messageId = await signalJsonRpcSend(jsonRpcParams);
        cacheSentMessage({
          provider: "signal",
          messageId: messageId || undefined,
          fromAddress: settings.account,
          recipientId,
          body,
          hasAttachments: !!opts?.attachments?.length,
        });
        return { ok: true, provider: "signal", recipientId, messageId };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Only fall back when the request provably never left this process. Any
        // ambiguity (post-write timeout/disconnect) is surfaced, never resent.
        const safeToRetry = err instanceof SignalSendError && err.phase === "preTransmit";
        if (!safeToRetry) {
          return {
            ok: false,
            provider: "signal",
            recipientId,
            error: `Signal send failed (delivery unknown, not retried): ${message}`,
          };
        }
        process.stderr.write(
          `[signal] JSON-RPC unreachable before transmit; falling back to signal-cli send: ${message}\n`,
        );
      }
    }

    // Direct send — account-correct by construction (`-a <account>`). Used when we
    // don't own the daemon socket, or after a provably-pre-transmit JSON-RPC failure.
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
      return {
        ok: false,
        provider: "signal",
        recipientId,
        error: result.stderr || result.stdout || `Exit code ${result.exitCode}`,
      };
    }
  },

  async inbox(opts) {
    const settings = resolveSettings(opts?.providerFlags);
    if (!settings) {
      console.error("Signal not configured. Run: onemessage auth signal");
      return [];
    }

    return inboxViaDaemon({
      provider: "signal",
      freshnessMs: getProviderFreshnessMs("signal"),
      account: settings.account,
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
    const msg = readFromCacheOrFail("signal", messageId);
    if (!msg) return null;

    const includeAttachments = opts?.includeAttachments ?? false;

    // Enrich attachments with filesystem paths when --attachments is requested
    if (includeAttachments && msg.attachments.length > 0) {
      const attachmentDir = getSignalAttachmentDir();
      msg.attachments = msg.attachments.map((att) => {
        // Type-cast to access the internal id field we stored at parse time
        const attWithId = att as Attachment & { id?: string };

        // Strip the internal id field before returning to consumer
        const { id: _internalId, ...publicAtt } = attWithId;

        let enriched: Attachment;

        if (!attWithId.id) {
          // No ID available → mark as unavailable
          enriched = { ...publicAtt, unavailable: "no-id" };
        } else {
          // ID exists - attempt to construct safe path (validates + globs for file)
          const result = constructSafeSignalAttachmentPathWithReason(attachmentDir, attWithId.id);

          if (result.success) {
            // Valid ID and file found on disk → set path
            enriched = { ...publicAtt, path: result.path };
          } else {
            // Failed with specific reason code
            enriched = { ...publicAtt, unavailable: result.reason };
          }
        }

        validateAttachment(enriched, { attachmentsRequested: includeAttachments });
        return enriched;
      });
    } else {
      // Inbox-light mode: strip internal id field and verify no data/path/unavailable is set
      msg.attachments = msg.attachments.map((att) => {
        const { id: _internalId, ...publicAtt } = att as Attachment & { id?: string };
        validateAttachment(publicAtt, { attachmentsRequested: includeAttachments });
        return publicAtt;
      });
    }

    return msg;
  },

  async search(query, opts) {
    return store.searchCached(query, "signal", {
      limit: opts?.limit,
      since: opts?.since,
    });
  },
};

registerProvider(signalProvider);
