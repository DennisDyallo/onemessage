import { loadConfig } from "./config.ts";
import { fetchSmsInbox } from "./providers/sms.ts";
import { cliExists } from "./providers/shared.ts";
import type { ProviderAdapter, DaemonOrchestrator } from "./daemon-adapter.ts";

export class SmsAdapter implements ProviderAdapter {
  readonly name = "sms";

  start(orchestrator: DaemonOrchestrator): void {
    if (!cliExists("kdeconnect-read-sms")) return;

    const config = loadConfig();
    const enabled = config.daemon?.providers?.sms?.enabled !== false;
    if (!enabled) return;

    const interval =
      config.daemon?.providers?.sms?.pollIntervalMs ??
      orchestrator.defaultPollInterval();

    orchestrator.schedulePoll("sms", interval, async () => {
      await fetchSmsInbox();
    });
  }

  async fetch(): Promise<void> {
    if (!cliExists("kdeconnect-read-sms")) {
      throw new Error("SMS polling requires kdeconnect-read-sms");
    }
    await fetchSmsInbox();
  }

  isActive(): boolean {
    return cliExists("kdeconnect-read-sms");
  }

  statusInfo(): Record<string, unknown> {
    return {};
  }

  cleanup(): void {
    // SMS has no persistent resources
  }
}
