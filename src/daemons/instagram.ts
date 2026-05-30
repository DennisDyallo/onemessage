import { loadConfig } from "../config.ts";
import { fetchInstagramInbox } from "../providers/instagram.ts";
import { cliExists } from "../providers/shared.ts";
import type { DaemonOrchestrator, ProviderAdapter } from "./adapter.ts";

export class InstagramAdapter implements ProviderAdapter {
  readonly name = "instagram";
  readonly polling = true;
  private username: string | null = null;
  private lastFetchAt = 0;
  private static readonly MIN_FETCH_INTERVAL_MS = 60_000; // hard 60s floor for live Instagram API calls

  start(orchestrator: DaemonOrchestrator): void {
    const config = loadConfig();
    this.username = config.instagram?.username ?? null;
    if (!this.username || !cliExists("instagram-cli")) return;

    const enabled = config.daemon?.providers?.instagram?.enabled !== false;
    if (!enabled) return;

    const interval =
      config.daemon?.providers?.instagram?.pollIntervalMs ?? orchestrator.defaultPollInterval();

    const username = this.username;
    orchestrator.schedulePoll("instagram", interval, () => this.actuallyFetch(username));
  }

  async fetch(): Promise<void> {
    if (!this.username) throw new Error("Instagram not configured");
    if (!cliExists("instagram-cli")) throw new Error("instagram-cli not available");
    await this.actuallyFetch(this.username);
  }

  private async actuallyFetch(username: string): Promise<void> {
    const now = Date.now();
    const sinceLast = now - this.lastFetchAt;
    if (sinceLast < InstagramAdapter.MIN_FETCH_INTERVAL_MS) {
      // Rate-limited: silently no-op rather than hammer Instagram. CLI sees cached data.
      return;
    }
    this.lastFetchAt = now;
    await fetchInstagramInbox(username);
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
