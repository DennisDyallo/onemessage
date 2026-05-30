import { loadConfig } from "../config.ts";
import { fetchInstagramInbox } from "../providers/instagram.ts";
import { cliExists } from "../providers/shared.ts";
import type { DaemonOrchestrator, DaemonResponse, IpcCapableAdapter } from "./adapter.ts";

export class InstagramAdapter implements IpcCapableAdapter {
  readonly name = "instagram";
  readonly polling = true;
  private username: string | null = null;
  private lastFetchAt = 0;
  // Per-thread rate-limit timestamps. The fetch-thread IPC is rate-limited independently
  // per thread ID (Instagram allows fetching distinct threads at roughly 1/60s each).
  // Inbox rate-limit (lastFetchAt) is a separate, single-channel counter.
  private lastThreadFetchAt = new Map<string, number>();
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
    await fetchInstagramInbox(username);
    this.lastFetchAt = Date.now(); // record AFTER success (so a thrown fetch doesn't start the window)
  }

  async actuallyFetchThread(threadId: string, username: string): Promise<void> {
    // Note on lastThreadFetchAt timing: fetchThreadMessages() swallows CLI errors and returns []
    // rather than throwing. That's intentional — even a failed/empty thread response means we DID
    // contact (or attempt to contact) Instagram, which counts toward their rate-limit detection.
    // Advancing lastThreadFetchAt after the await is therefore correct: we want the 60s window to
    // start on any API touch, not only on success. Contrast with actuallyFetch() where
    // fetchInstagramInbox() throws on hard failure (e.g. CLI not found) and the timestamp
    // correctly doesn't advance.

    const now = Date.now();
    const lastFetch = this.lastThreadFetchAt.get(threadId) ?? 0;
    const sinceLast = now - lastFetch;
    if (sinceLast < InstagramAdapter.MIN_FETCH_INTERVAL_MS) {
      // Rate-limited: silently no-op rather than hammer Instagram. CLI sees cached data.
      return;
    }

    const { fetchThreadMessages } = await import("../providers/instagram.ts");
    const messages = await fetchThreadMessages(threadId, "", username);

    if (messages.length > 0) {
      const { upsertFullMessages } = await import("../store.ts");
      const incoming = messages.filter((m) => m.from?.address !== "me");
      const outgoing = messages.filter((m) => m.from?.address === "me");
      if (incoming.length > 0) upsertFullMessages(incoming, threadId);
      if (outgoing.length > 0) upsertFullMessages(outgoing, threadId);
    }

    this.lastThreadFetchAt.set(threadId, Date.now()); // record AFTER success
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

  ipcTypes(): string[] {
    return ["fetch-thread"];
  }

  async handleIpc(req: Record<string, unknown>): Promise<DaemonResponse | undefined> {
    if (req.type === "fetch-thread") {
      return this.handleFetchThread(req as { threadId?: string; account?: string });
    }
    return undefined;
  }

  private async handleFetchThread(req: {
    threadId?: string;
    account?: string;
  }): Promise<DaemonResponse> {
    if (!req.threadId) {
      return { ok: false, error: "threadId required" };
    }

    const username = req.account ?? this.username;
    if (!username) {
      return { ok: false, error: "Instagram not configured" };
    }

    try {
      await this.actuallyFetchThread(req.threadId, username);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}
