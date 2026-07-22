import { loadConfig } from "../config.ts";
import { cliExists } from "../providers/shared.ts";
import { fetchBeeperSmsMessages, resolveSmsBackend, resolveSmsSettings } from "../providers/sms.ts";
import { fetchKdeSmsInbox, resolveKdeSmsSettings } from "../providers/sms-kdeconnect.ts";
import type { DaemonOrchestrator, ProviderAdapter } from "./adapter.ts";

export class SmsAdapter implements ProviderAdapter {
  readonly name = "sms";
  readonly polling = true;

  start(orchestrator: DaemonOrchestrator): void {
    if (!this.isActive()) return;

    const config = loadConfig();
    const enabled = config.daemon?.providers?.sms?.enabled !== false;
    if (!enabled) return;

    const interval =
      config.daemon?.providers?.sms?.pollIntervalMs ?? orchestrator.defaultPollInterval();

    orchestrator.schedulePoll("sms", interval, async () => {
      await this.fetch();
    });
  }

  async fetch(): Promise<void> {
    if (!this.isActive()) {
      throw new Error("SMS polling backend is not configured");
    }
    if (resolveSmsBackend() === "kdeconnect") {
      fetchKdeSmsInbox({ fresh: true });
      return;
    }
    const settings = resolveSmsSettings();
    if (!settings) throw new Error("SMS/RCS Beeper backend is not configured");
    await fetchBeeperSmsMessages(settings);
  }

  isActive(): boolean {
    if (resolveSmsBackend() === "beeper") return resolveSmsSettings() !== null;
    return (
      (cliExists("dbus-send") || cliExists("kdeconnect-read-sms")) &&
      resolveKdeSmsSettings() !== null
    );
  }

  statusInfo(): Record<string, unknown> {
    const backend = resolveSmsBackend();
    return {
      backend,
      ...(backend === "beeper" ? { accountId: resolveSmsSettings()?.accountId ?? null } : {}),
    };
  }

  cleanup(): void {
    // SMS has no persistent resources
  }
}
