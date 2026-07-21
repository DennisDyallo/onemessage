import { loadConfig } from "../config.ts";
import { fetchMessengerMessages, resolveMessengerSettings } from "../providers/messenger.ts";
import type { DaemonOrchestrator, ProviderAdapter } from "./adapter.ts";

export class MessengerAdapter implements ProviderAdapter {
  readonly name = "messenger";
  readonly polling = true;

  start(orchestrator: DaemonOrchestrator): void {
    if (!resolveMessengerSettings()) return;
    const providerConfig = loadConfig().daemon?.providers?.messenger;
    if (providerConfig?.enabled === false) return;
    const interval = providerConfig?.pollIntervalMs ?? orchestrator.defaultPollInterval();
    orchestrator.schedulePoll(this.name, interval, () => this.fetch());
  }

  async fetch(): Promise<void> {
    const settings = resolveMessengerSettings();
    if (!settings) throw new Error("Messenger not configured");
    await fetchMessengerMessages(settings);
  }

  isActive(): boolean {
    return resolveMessengerSettings() !== null;
  }

  statusInfo(): Record<string, unknown> {
    return {};
  }

  cleanup(): void {}
}
