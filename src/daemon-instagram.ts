import { loadConfig } from "./config.ts";
import type { DaemonOrchestrator, ProviderAdapter } from "./daemon-adapter.ts";
import { fetchInstagramInbox } from "./providers/instagram.ts";
import { cliExists } from "./providers/shared.ts";

export class InstagramAdapter implements ProviderAdapter {
  readonly name = "instagram";
  readonly polling = true;
  private username: string | null = null;

  start(orchestrator: DaemonOrchestrator): void {
    const config = loadConfig();
    this.username = config.instagram?.username ?? null;
    if (!this.username || !cliExists("instagram-cli")) return;

    const enabled = config.daemon?.providers?.instagram?.enabled !== false;
    if (!enabled) return;

    const interval =
      config.daemon?.providers?.instagram?.pollIntervalMs ?? orchestrator.defaultPollInterval();

    const username = this.username;
    orchestrator.schedulePoll("instagram", interval, () => fetchInstagramInbox(username));
  }

  async fetch(): Promise<void> {
    if (!this.username) throw new Error("Instagram not configured");
    if (!cliExists("instagram-cli")) throw new Error("instagram-cli not available");
    await fetchInstagramInbox(this.username);
  }

  isActive(): boolean {
    return this.username !== null && cliExists("instagram-cli");
  }

  statusInfo(): Record<string, unknown> {
    return {};
  }

  cleanup(): void {
    // Instagram has no persistent resources
  }
}
