import { loadConfig } from "./config.ts";
import {
  fetchEmailInbox,
  resolveSettings as resolveEmailSettings,
} from "./providers/email.ts";
import type { ProviderAdapter, DaemonOrchestrator } from "./daemon-adapter.ts";

export class EmailAdapter implements ProviderAdapter {
  readonly name = "email";
  readonly polling = true;
  private active = false;

  start(orchestrator: DaemonOrchestrator): void {
    // Check if email is configured at startup (for isActive reporting),
    // but resolve settings inside each poll so config changes take effect
    // without a daemon restart.
    const initialSettings = resolveEmailSettings();
    if (!initialSettings) return;

    this.active = true;

    const config = loadConfig();
    const enabled = config.daemon?.providers?.email?.enabled !== false;
    if (!enabled) return;

    const interval =
      config.daemon?.providers?.email?.pollIntervalMs ??
      orchestrator.defaultPollInterval();

    orchestrator.schedulePoll("email", interval, async () => {
      const settings = resolveEmailSettings();
      if (!settings) return;
      await fetchEmailInbox(settings, settings.accounts, "INBOX");
    });
  }

  async fetch(): Promise<void> {
    const settings = resolveEmailSettings();
    if (!settings) throw new Error("Email not configured");
    await fetchEmailInbox(settings, settings.accounts, "INBOX");
  }

  isActive(): boolean {
    return this.active;
  }

  statusInfo(): Record<string, unknown> {
    return {};
  }

  cleanup(): void {
    // Email has no persistent resources
  }
}
