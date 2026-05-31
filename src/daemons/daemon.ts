/**
 * Unified onemessage daemon — orchestrates provider adapters for real-time
 * connections (WhatsApp) and polling (Signal, Email, SMS, Telegram, Instagram).
 *
 * Usage: bun run src/daemon.ts
 *
 * Runtime paths (under ~/.config/onemessage/):
 *   daemon.pid  — PID file
 *   daemon.sock — Unix domain socket for IPC
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";

import { loadConfig } from "../config.ts";
import type { DaemonOrchestrator, DaemonResponse, ProviderAdapter } from "./adapter.ts";
import { isIpcCapable } from "./adapter.ts";
import { EmailAdapter } from "./email.ts";
import { InstagramAdapter } from "./instagram.ts";
import { MatrixAdapter } from "./matrix.ts";
import { DAEMON_PID, DAEMON_SOCK } from "./shared.ts";
import { SignalAdapter } from "./signal.ts";
import { SmsAdapter } from "./sms.ts";
import { TelegramBotAdapter } from "./telegram-bot.ts";
import { WhatsAppAdapter } from "./whatsapp.ts";

// ---------------------------------------------------------------------------
// IPC types
// ---------------------------------------------------------------------------

type DaemonRequest =
  | { type: "status" }
  | { type: "ping" }
  | { type: "fetch"; provider?: string }
  | { type: "providers" }
  | { type: string; [key: string]: unknown }; // adapter-delegated types

// ---------------------------------------------------------------------------
// UnifiedDaemon
// ---------------------------------------------------------------------------

export class UnifiedDaemon {
  // Provider adapters
  private adapters: ProviderAdapter[] = [];
  private adapterMap = new Map<string, ProviderAdapter>();

  // Polling
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private polling = new Map<string, boolean>();
  private lastPoll = new Map<string, number>();
  private inflightFetches = new Map<string, Promise<void>>();

  // IPC
  private unixServer: ReturnType<typeof Bun.listen> | null = null;
  private ipcTypeOwners = new Map<string, import("./adapter.ts").IpcCapableAdapter>();

  // Lifecycle
  private startTime = Date.now();

  constructor(adapters?: ProviderAdapter[]) {
    if (adapters) {
      this.adapters = adapters;
      for (const a of adapters) this.adapterMap.set(a.name, a);
      this.buildIpcTypeRegistry();
    }
  }

  /**
   * Build IPC type-owner registry and fail-fast on collisions.
   * Called from constructor (test injection) and startAdapters (production).
   */
  private buildIpcTypeRegistry(): void {
    this.ipcTypeOwners.clear();
    const collisions: Array<{ type: string; owners: string[] }> = [];
    const typeToAdapters = new Map<string, string[]>();

    // First pass: collect all type claims
    for (const adapter of this.adapters) {
      if (isIpcCapable(adapter)) {
        for (const type of adapter.ipcTypes()) {
          const existing = typeToAdapters.get(type);
          if (existing) {
            existing.push(adapter.name);
          } else {
            typeToAdapters.set(type, [adapter.name]);
          }
        }
      }
    }

    // Second pass: detect collisions and populate registry
    for (const [type, owners] of typeToAdapters) {
      if (owners.length > 1) {
        collisions.push({ type, owners });
      } else {
        const adapter = this.adapters.find(
          (a) => isIpcCapable(a) && a.name === owners[0],
        ) as import("./adapter.ts").IpcCapableAdapter;
        this.ipcTypeOwners.set(type, adapter);
      }
    }

    // Fail-fast if collisions exist
    if (collisions.length > 0) {
      const details = collisions
        .map(({ type, owners }) => `type "${type}" is claimed by ${owners.join(" and ")}`)
        .join(". ");
      throw new Error(`IPC type collision detected: ${details}`);
    }
  }

  /** Derive polled provider names from runtime state — never hardcode. */
  private polledProviderNames(): string[] {
    const names = new Set<string>();
    for (const name of this.pollTimers.keys()) names.add(name);
    for (const name of this.lastPoll.keys()) names.add(name);
    for (const adapter of this.adapters) {
      if (adapter.isActive()) names.add(adapter.name);
    }
    return [...names];
  }

  // -----------------------------------------------------------------------
  // Start
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    const configDir = DAEMON_PID.replace(/\/[^/]+$/, "");
    mkdirSync(configDir, { recursive: true });

    // Write PID file
    writeFileSync(DAEMON_PID, String(process.pid), "utf-8");

    // Clean up stale socket
    if (existsSync(DAEMON_SOCK)) {
      try {
        unlinkSync(DAEMON_SOCK);
      } catch {
        // ignore
      }
    }

    // Start all provider adapters
    await this.startAdapters();

    // Start IPC server
    this.startIpcServer();

    // Graceful shutdown
    process.on("SIGTERM", () => this.cleanup());
    process.on("SIGINT", () => this.cleanup());

    process.stderr.write(`[daemon] started pid=${process.pid} sock=${DAEMON_SOCK}\n`);
  }

  // -----------------------------------------------------------------------
  // Provider adapters
  // -----------------------------------------------------------------------

  private async startAdapters(): Promise<void> {
    if (this.adapters.length === 0) {
      this.adapters = [
        new WhatsAppAdapter(),
        new SignalAdapter(),
        new EmailAdapter(),
        new SmsAdapter(),
        new TelegramBotAdapter(),
        new InstagramAdapter(),
        new MatrixAdapter(),
      ];

      for (const adapter of this.adapters) {
        this.adapterMap.set(adapter.name, adapter);
      }

      this.buildIpcTypeRegistry();
    }

    const orchestrator: DaemonOrchestrator = {
      schedulePoll: (name, interval, fn) => this.schedulePoll(name, interval, fn),
      pollNow: (name, fn) => this.pollProvider(name, fn),
      setLastPoll: (name) => this.lastPoll.set(name, Date.now()),
      defaultPollInterval: () => {
        const config = loadConfig();
        return config.daemon?.pollIntervalMs ?? 60_000;
      },
    };

    for (const adapter of this.adapters) {
      await adapter.start(orchestrator);
    }
  }

  private schedulePoll(name: string, intervalMs: number, fn: () => void | Promise<void>): void {
    this.pollProvider(name, fn).catch(() => {}); // Errors logged inside pollProvider
    this.pollTimers.set(
      name,
      setInterval(() => this.pollProvider(name, fn).catch(() => {}), intervalMs),
    );
    process.stderr.write(`[daemon] polling ${name} every ${Math.round(intervalMs / 1000)}s\n`);
  }

  private async pollProvider(name: string, fn: () => void | Promise<void>): Promise<void> {
    // Coalesce concurrent fetches — if a fetch is in flight, return that promise
    const inflight = this.inflightFetches.get(name);
    if (inflight) return inflight;

    // Use IIFE instead of async promise executor
    const promise = (async () => {
      // Yield one microtask so the outer .set(name, promise) runs before this body executes
      await Promise.resolve();
      this.polling.set(name, true);
      try {
        await fn();
        this.lastPoll.set(name, Date.now());
        process.stderr.write(`[daemon] ${name} polled successfully\n`);
      } catch (err) {
        process.stderr.write(`[daemon] ${name} poll failed: ${err}\n`);
        throw err; // propagate to all in-flight callers
      } finally {
        this.polling.set(name, false);
        this.inflightFetches.delete(name);
      }
    })();

    this.inflightFetches.set(name, promise);
    return promise;
  }

  // -----------------------------------------------------------------------
  // IPC server (Unix domain socket)
  // -----------------------------------------------------------------------

  private startIpcServer(): void {
    const self = this;

    this.unixServer = Bun.listen({
      unix: DAEMON_SOCK,
      socket: {
        data(socket, data) {
          const raw = typeof data === "string" ? data : Buffer.from(data).toString("utf-8");

          const lines = raw.split("\n").filter((l) => l.trim());
          const firstLine = lines[0];
          if (!firstLine) return;

          (async () => {
            try {
              const resp = await self.handleRequest(firstLine);
              try {
                socket.write(JSON.stringify(resp));
              } catch (writeErr) {
                process.stderr.write(`[daemon] socket.write failed: ${writeErr}\n`);
              }
              socket.end();
            } catch (err) {
              const errResp: DaemonResponse = {
                ok: false,
                error: String(err),
              };
              try {
                socket.write(JSON.stringify(errResp));
              } catch (writeErr) {
                process.stderr.write(`[daemon] error response write failed: ${writeErr}\n`);
              }
              socket.end();
            }
          })();
        },
        open() {},
        close() {},
        error(_socket, err) {
          process.stderr.write(`[daemon] socket error: ${err}\n`);
        },
      },
    });
  }

  async processIpc(raw: string): Promise<DaemonResponse> {
    return this.handleRequest(raw);
  }

  private async handleRequest(raw: string): Promise<DaemonResponse> {
    let req: DaemonRequest;
    try {
      req = JSON.parse(raw);
    } catch {
      return { ok: false, error: "invalid JSON" };
    }

    switch (req.type) {
      case "ping":
        return { ok: true };

      case "status": {
        const pollingStatus: Record<
          string,
          { lastPoll: string | null; enabled: boolean; mode?: string }
        > = {};
        const realtimeStatus: Record<string, Record<string, unknown>> = {};

        for (const name of this.polledProviderNames()) {
          const adapter = this.adapterMap.get(name);
          if (adapter && !adapter.polling) {
            // Real-time adapter — report separately
            realtimeStatus[name] = adapter.statusInfo();
            continue;
          }
          const lastMs = this.lastPoll.get(name);
          pollingStatus[name] = {
            lastPoll: lastMs ? new Date(lastMs).toISOString() : null,
            enabled: this.pollTimers.has(name) || (adapter?.isActive() ?? false),
            ...(adapter?.statusInfo() ?? {}),
          };
        }

        return {
          ok: true,
          data: {
            pid: process.pid,
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
            ...realtimeStatus,
            polling: pollingStatus,
          },
        };
      }

      case "fetch": {
        const provider = req.provider as string | undefined;

        if (provider) {
          const adapter = this.adapterMap.get(provider);
          if (!adapter) {
            return {
              ok: false,
              error: `unknown provider: ${provider}`,
            };
          }
          if (!adapter.isActive()) {
            return { ok: false, error: `${provider} not configured` };
          }
          try {
            await this.pollProvider(provider, () => adapter.fetch());
            return { ok: true };
          } catch (err) {
            return { ok: false, error: String(err) };
          }
        }

        const promises: Promise<void>[] = [];
        for (const adapter of this.adapters) {
          if (adapter.isActive()) {
            promises.push(this.pollProvider(adapter.name, () => adapter.fetch()));
          }
        }
        await Promise.allSettled(promises);
        return { ok: true };
      }

      case "providers": {
        const providers: Record<
          string,
          { enabled: boolean; polling: boolean; lastPoll: string | null }
        > = {};

        for (const adapter of this.adapters) {
          const lastMs = this.lastPoll.get(adapter.name);
          providers[adapter.name] = {
            enabled: adapter.isActive(),
            polling: this.polling.get(adapter.name) ?? false,
            lastPoll: lastMs ? new Date(lastMs).toISOString() : null,
          };
        }

        return { ok: true, data: providers };
      }

      default: {
        // Direct registry lookup — no iteration, no silent shadowing
        const reqType = (req as { type: string }).type;
        const owner = this.ipcTypeOwners.get(reqType);
        if (owner) {
          const result = await owner.handleIpc(req as Record<string, unknown>);
          if (result !== undefined) return result;
        }

        return {
          ok: false,
          error: `unknown request type: ${reqType}`,
        };
      }
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  private cleanup(): void {
    for (const adapter of this.adapters) {
      try {
        adapter.cleanup();
      } catch {
        // ignore
      }
    }

    // Close Unix socket server
    try {
      this.unixServer?.stop();
    } catch {
      // ignore
    }

    // Clear poll timers
    for (const timer of this.pollTimers.values()) {
      clearInterval(timer);
    }
    this.pollTimers.clear();

    // Delete PID file
    try {
      if (existsSync(DAEMON_PID)) unlinkSync(DAEMON_PID);
    } catch {
      // ignore
    }

    // Delete socket file
    try {
      if (existsSync(DAEMON_SOCK)) unlinkSync(DAEMON_SOCK);
    } catch {
      // ignore
    }

    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const daemon = new UnifiedDaemon();
  daemon.start().catch((err) => {
    process.stderr.write(`[daemon] fatal: ${err}\n`);
    process.exit(1);
  });
}
