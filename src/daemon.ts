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

import { loadConfig } from "./config.ts";
import type { DaemonOrchestrator, DaemonResponse, ProviderAdapter } from "./daemon-adapter.ts";
import { isIpcCapable } from "./daemon-adapter.ts";
import { EmailAdapter } from "./daemon-email.ts";
import { InstagramAdapter } from "./daemon-instagram.ts";
import { DAEMON_PID, DAEMON_SOCK } from "./daemon-shared.ts";
import { SignalAdapter } from "./daemon-signal.ts";
import { SmsAdapter } from "./daemon-sms.ts";
import { TelegramBotAdapter } from "./daemon-telegram-bot.ts";
import { WhatsAppAdapter } from "./daemon-whatsapp.ts";

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

  // IPC
  private unixServer: ReturnType<typeof Bun.listen> | null = null;

  // Lifecycle
  private startTime = Date.now();

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
    this.adapters = [
      new WhatsAppAdapter(),
      new SignalAdapter(),
      new EmailAdapter(),
      new SmsAdapter(),
      new TelegramBotAdapter(),
      new InstagramAdapter(),
    ];

    for (const adapter of this.adapters) {
      this.adapterMap.set(adapter.name, adapter);
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
    this.pollProvider(name, fn);
    this.pollTimers.set(
      name,
      setInterval(() => this.pollProvider(name, fn), intervalMs),
    );
    process.stderr.write(`[daemon] polling ${name} every ${Math.round(intervalMs / 1000)}s\n`);
  }

  private async pollProvider(name: string, fn: () => void | Promise<void>): Promise<void> {
    if (this.polling.get(name)) return; // skip if still running
    this.polling.set(name, true);
    try {
      await fn();
      this.lastPoll.set(name, Date.now());
      process.stderr.write(`[daemon] ${name} polled successfully\n`);
    } catch (err) {
      process.stderr.write(`[daemon] ${name} poll failed: ${err}\n`);
    } finally {
      this.polling.set(name, false);
    }
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
        // Try IPC-capable adapters before returning unknown
        for (const adapter of this.adapters) {
          if (isIpcCapable(adapter)) {
            const result = await adapter.handleIpc(req as Record<string, unknown>);
            if (result !== undefined) return result;
          }
        }

        return {
          ok: false,
          error: `unknown request type: ${(req as { type: string }).type}`,
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

const daemon = new UnifiedDaemon();
daemon.start().catch((err) => {
  process.stderr.write(`[daemon] fatal: ${err}\n`);
  process.exit(1);
});
