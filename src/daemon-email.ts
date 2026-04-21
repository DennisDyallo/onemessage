import { loadConfig } from "./config.ts";
import {
  fetchEmailInbox,
  resolveSettings as resolveEmailSettings,
} from "./providers/email.ts";
import type { ProviderAdapter, DaemonOrchestrator } from "./daemon-adapter.ts";

export class EmailAdapter implements ProviderAdapter {
  readonly name = "email";
  private settings: ReturnType<typeof resolveEmailSettings> | null = null;

  start(orchestrator: DaemonOrchestrator): void {
    this.settings = resolveEmailSettings();
    if (!this.settings) return;

    const config = loadConfig();
    const enabled = config.daemon?.providers?.email?.enabled !== false;
    if (!enabled) return;

    const interval =
      config.daemon?.providers?.email?.pollIntervalMs ??
      orchestrator.defaultPollInterval();

    orchestrator.schedulePoll("email", interval, async () => {
      await fetchEmailInbox(this.settings!, this.settings!.accounts, "INBOX");
    });
  }

  async fetch(): Promise<void> {
    if (!this.settings) throw new Error("Email not configured");
    await fetchEmailInbox(this.settings, this.settings.accounts, "INBOX");
  }

  isActive(): boolean {
    return this.settings !== null;
  }

  statusInfo(): Record<string, unknown> {
    return {};
  }

  cleanup(): void {
    // Email has no persistent resources
  }
}
