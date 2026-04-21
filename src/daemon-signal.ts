/**
 * Signal provider adapter for the unified daemon.
 *
 * Encapsulates all Signal-specific logic: daemon mode, poll mode, fetch,
 * cleanup. The UnifiedDaemon only calls the adapter's interface methods.
 */

import { loadConfig } from "./config.ts";
import type { DaemonOrchestrator, ProviderAdapter } from "./daemon-adapter.ts";
import {
  fetchSignalInboxAsync,
  processSignalMessages,
  type SignalDaemonHandle,
  startSignalDaemon,
} from "./providers/signal.ts";
import * as store from "./store.ts";

// ---------------------------------------------------------------------------
// Signal adapter
// ---------------------------------------------------------------------------

export class SignalAdapter implements ProviderAdapter {
  readonly name = "signal";
  readonly polling = true;
  private daemonHandle: SignalDaemonHandle | null = null;
  private phone: string | null = null;

  start(orchestrator: DaemonOrchestrator): void {
    const config = loadConfig();
    const signalConfig = config.signal;
    if (!signalConfig?.phone) return;

    this.phone = signalConfig.phone;
    const enabled = config.daemon?.providers?.signal?.enabled !== false;
    if (!enabled) return;

    const mode = config.daemon?.providers?.signal?.mode ?? "poll";
    const interval =
      config.daemon?.providers?.signal?.pollIntervalMs ?? orchestrator.defaultPollInterval();

    const phone = this.phone;
    if (mode === "daemon") {
      this.daemonHandle = startSignalDaemon({
        account: phone,
        onMessage: (messages) => {
          const { incoming, outgoing } = processSignalMessages(messages, phone);
          store.recordFetch("signal", phone);
          orchestrator.setLastPoll("signal");
          process.stderr.write(`[daemon] signal daemon: ${incoming} in + ${outgoing} out\n`);
        },
        onError: (error) => {
          process.stderr.write(`[daemon] signal daemon error: ${error}\n`);
        },
      });
      // Backfill any missed messages
      orchestrator.pollNow("signal", () => fetchSignalInboxAsync(phone));
      process.stderr.write("[daemon] signal using real-time daemon mode\n");
    } else {
      orchestrator.schedulePoll("signal", interval, () => fetchSignalInboxAsync(phone));
    }
  }

  async fetch(): Promise<void> {
    if (!this.phone) throw new Error("signal not configured");
    await fetchSignalInboxAsync(this.phone);
  }

  isActive(): boolean {
    return this.daemonHandle !== null || this.phone !== null;
  }

  statusInfo(): Record<string, unknown> {
    if (this.daemonHandle) return { mode: "daemon" };
    return {};
  }

  cleanup(): void {
    try {
      this.daemonHandle?.stop();
    } catch {
      // ignore
    }
    this.daemonHandle = null;
  }
}
