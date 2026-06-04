import { loadConfig } from "../config.ts";
import { cliExists } from "../providers/shared.ts";
import { fetchSmsInbox, resolveSettings as resolveSmsSettings } from "../providers/sms.ts";
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
      await fetchSmsInbox({ fresh: true });
    });
  }

  async fetch(): Promise<void> {
    if (!this.isActive()) {
      throw new Error("SMS polling requires KDE Connect SMS read support");
    }
    await fetchSmsInbox({ fresh: true });
  }

  isActive(): boolean {
    return (
      (cliExists("dbus-send") || cliExists("kdeconnect-read-sms")) && resolveSmsSettings() !== null
    );
  }

  statusInfo(): Record<string, unknown> {
    return {};
  }

  cleanup(): void {
    // SMS has no persistent resources
  }
}
