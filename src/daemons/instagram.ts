import { getMinimumProviderFreshnessMs, loadConfig } from "../config.ts";
import {
  fetchInstagramInbox,
  getNormalizedInstagramThread,
  listInstagramInventoryThreads,
} from "../providers/instagram.ts";
import { cliExists } from "../providers/shared.ts";
import * as store from "../store.ts";
import type { MessageFull } from "../types.ts";
import type { DaemonOrchestrator, DaemonResponse, IpcCapableAdapter } from "./adapter.ts";

const COOLDOWN_MS = 24 * 60 * 60_000;
const REQUEST_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_REQUESTS_PER_DAY = 10;
const DEFAULT_MIN_REQUEST_SPACING_MS = 2_000;
const DEFAULT_MAX_INVENTORY_PAGES = 1;
const DEFAULT_MAX_THREAD_PAGES = 2;
const DEFAULT_THREAD_PAGE_LIMIT = 20;

type InstagramFetchMeta =
  | { performed: true; sourceFetchedAt: string }
  | {
      performed: false;
      reason: "cache-only" | "cooldown" | "fresh-cache" | "rate-limited" | "budget-exhausted";
    };

type InstagramInventoryData = InstagramFetchMeta & {
  threads: unknown[];
  pagesFetched?: number;
  stopReason?:
    | "complete"
    | "cache-only"
    | "cooldown"
    | "fresh-cache"
    | "rate-limited"
    | "budget-exhausted";
};

type InstagramThreadDeltaData = InstagramFetchMeta & {
  messages?: unknown[];
  anchorFound?: boolean;
  historyExhausted?: boolean;
  nextCursor?: string;
  stopReason?:
    | "anchor-found"
    | "history-exhausted"
    | "page-cap"
    | "message-cap"
    | "budget-exhausted";
  thread?: unknown;
};

interface InstagramAdapterDeps {
  fetchInbox: typeof fetchInstagramInbox;
  fetchThread?: (threadId: string, username: string) => Promise<MessageFull[]>;
}

function classifyInstagramError(err: unknown): string {
  const message = String(err).toLowerCase();
  if (message.includes("login_required")) return "login_required";
  if (message.includes("checkpoint") || message.includes("challenge")) return "checkpoint";
  if (message.includes("rate") || message.includes("429")) return "rate_limit";
  if (message.includes("403")) return "forbidden";
  return "unknown";
}

function shouldStartCooldown(errorClass: string): boolean {
  return ["login_required", "checkpoint", "rate_limit", "forbidden"].includes(errorClass);
}

function readTime(value: string | null): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class InstagramAdapter implements IpcCapableAdapter {
  readonly name = "instagram";
  readonly polling = true;
  private username: string | null = null;
  private lastFetchAt = 0;
  // Per-thread rate-limit timestamps. The fetch-thread IPC is rate-limited independently
  // per thread ID.
  // Inbox rate-limit (lastFetchAt) is a separate, single-channel counter.
  private lastThreadFetchAt = new Map<string, number>();
  private requestBudgetQueue: Promise<void> = Promise.resolve();
  // Hard floor for live Instagram API calls, including CLI --fresh paths.
  private static readonly MIN_FETCH_INTERVAL_MS = getMinimumProviderFreshnessMs("instagram");

  constructor(private readonly deps: InstagramAdapterDeps = { fetchInbox: fetchInstagramInbox }) {}

  private maxRequestsPerDay(): number {
    const configured = loadConfig().daemon?.providers?.instagram?.maxRequestsPerDay;
    return typeof configured === "number" && configured > 0
      ? configured
      : DEFAULT_MAX_REQUESTS_PER_DAY;
  }

  private minRequestSpacingMs(): number {
    const configured = loadConfig().daemon?.providers?.instagram?.minRequestSpacingMs;
    return typeof configured === "number" && configured >= 0
      ? configured
      : DEFAULT_MIN_REQUEST_SPACING_MS;
  }

  private requestBudgetKey(name: string): string {
    return `request_budget_${name}`;
  }

  private readRequestBudget(username: string): { windowStartedAt: number; count: number } {
    const now = Date.now();
    const windowStartedAt = readTime(
      store.getCursor("instagram", username, this.requestBudgetKey("window_started_at")),
    );
    const count =
      Number(store.getCursor("instagram", username, this.requestBudgetKey("count")) ?? "0") || 0;
    if (!windowStartedAt || now - windowStartedAt >= REQUEST_WINDOW_MS) {
      return { windowStartedAt: now, count: 0 };
    }
    return { windowStartedAt, count };
  }

  private async serializeSourceRequests<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.requestBudgetQueue;
    this.requestBudgetQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async reserveSourceRequests(
    username: string,
    count: number,
  ): Promise<{
    windowStartedAt: number;
    previousCount: number;
    reservedCount: number;
  } | null> {
    const requested = Math.max(1, Math.floor(count));
    const now = Date.now();
    const lastAttempt = readTime(store.getCursor("instagram", username, "last_source_request_at"));
    const delayMs = Math.max(0, this.minRequestSpacingMs() - (now - lastAttempt));
    if (delayMs > 0) await sleep(delayMs);

    const budget = this.readRequestBudget(username);
    if (budget.count + requested > this.maxRequestsPerDay()) return null;

    store.setCursor(
      "instagram",
      username,
      this.requestBudgetKey("window_started_at"),
      new Date(budget.windowStartedAt).toISOString(),
    );
    store.setCursor(
      "instagram",
      username,
      this.requestBudgetKey("count"),
      String(budget.count + requested),
    );
    store.setCursor("instagram", username, "last_source_request_at", new Date().toISOString());
    return {
      windowStartedAt: budget.windowStartedAt,
      previousCount: budget.count,
      reservedCount: requested,
    };
  }

  private reconcileSourceRequests(
    username: string,
    reservation: { windowStartedAt: number; previousCount: number; reservedCount: number },
    actualCount: number,
  ): void {
    const actual = Number.isFinite(actualCount)
      ? Math.min(reservation.reservedCount, Math.max(1, Math.floor(actualCount)))
      : reservation.reservedCount;
    store.setCursor(
      "instagram",
      username,
      this.requestBudgetKey("window_started_at"),
      new Date(reservation.windowStartedAt).toISOString(),
    );
    store.setCursor(
      "instagram",
      username,
      this.requestBudgetKey("count"),
      String(reservation.previousCount + actual),
    );
  }

  start(orchestrator: DaemonOrchestrator): void {
    const config = loadConfig();
    this.username = config.instagram?.username ?? null;
    if (!this.username || !cliExists("instagram-cli")) return;

    const enabled = config.daemon?.providers?.instagram?.enabled === true;
    if (!enabled) return;

    const interval =
      config.daemon?.providers?.instagram?.pollIntervalMs ?? orchestrator.defaultPollInterval();

    const username = this.username;
    orchestrator.schedulePoll("instagram", interval, async () => {
      await this.actuallyFetch(username);
    });
  }

  async fetch(): Promise<void> {
    if (!this.username) throw new Error("Instagram not configured");
    if (!cliExists("instagram-cli")) throw new Error("instagram-cli not available");
    await this.actuallyFetch(this.username);
  }

  private async actuallyFetch(
    username: string,
    opts?: { maxPages?: number },
  ): Promise<InstagramFetchMeta & { threads?: unknown[]; pagesFetched?: number }> {
    return this.serializeSourceRequests(async () => {
      const now = Date.now();
      const cooldownUntil = readTime(store.getCursor("instagram", username, "cooldown_until"));
      if (cooldownUntil > now) return { performed: false, reason: "cooldown" };

      if (store.isFresh("instagram", InstagramAdapter.MIN_FETCH_INTERVAL_MS, username)) {
        this.lastFetchAt = now;
        return { performed: false, reason: "fresh-cache" };
      }

      const sinceLast = now - this.lastFetchAt;
      if (sinceLast < InstagramAdapter.MIN_FETCH_INTERVAL_MS) {
        return { performed: false, reason: "rate-limited" };
      }

      const maxPages = Math.max(1, Math.floor(opts?.maxPages ?? DEFAULT_MAX_INVENTORY_PAGES));
      const reservation = await this.reserveSourceRequests(username, maxPages);
      if (!reservation) return { performed: false, reason: "budget-exhausted" };

      this.lastFetchAt = now; // record BEFORE live attempt so failures do not retry every poll tick
      store.setCursor("instagram", username, "last_attempt_at", new Date(now).toISOString());

      try {
        const result = await this.deps.fetchInbox(username, { pages: maxPages });
        this.reconcileSourceRequests(username, reservation, result.pagesFetched);
        const sourceFetchedAt = new Date().toISOString();
        store.setCursor("instagram", username, "last_success_at", sourceFetchedAt);
        store.setCursor("instagram", username, "last_error_class", "");
        store.setCursor("instagram", username, "cooldown_until", "");
        return {
          performed: true,
          sourceFetchedAt,
          threads: result.threads,
          pagesFetched: result.pagesFetched,
        };
      } catch (err) {
        const errorClass = classifyInstagramError(err);
        store.setCursor("instagram", username, "last_error_class", errorClass);
        if (shouldStartCooldown(errorClass)) {
          store.setCursor(
            "instagram",
            username,
            "cooldown_until",
            new Date(Date.now() + COOLDOWN_MS).toISOString(),
          );
        }
        throw err;
      }
    });
  }

  async actuallyFetchThread(threadId: string, username: string): Promise<InstagramFetchMeta> {
    return this.serializeSourceRequests(() =>
      this.actuallyFetchThreadSerialized(threadId, username),
    );
  }

  private async actuallyFetchThreadSerialized(
    threadId: string,
    username: string,
  ): Promise<InstagramFetchMeta> {
    const now = Date.now();
    const cooldownUntil = readTime(store.getCursor("instagram", username, "cooldown_until"));
    if (cooldownUntil > now) return { performed: false, reason: "cooldown" };

    const lastFetch = this.lastThreadFetchAt.get(threadId) ?? 0;
    const sinceLast = now - lastFetch;
    if (sinceLast < InstagramAdapter.MIN_FETCH_INTERVAL_MS) {
      // Rate-limited: silently no-op rather than hammer Instagram. CLI sees cached data.
      return { performed: false, reason: "rate-limited" };
    }

    this.lastThreadFetchAt.set(threadId, now);
    store.setCursor("instagram", username, "last_attempt_at", new Date(now).toISOString());
    if (!(await this.reserveSourceRequests(username, 1))) {
      return { performed: false, reason: "budget-exhausted" };
    }

    let messages: MessageFull[];
    try {
      messages = this.deps.fetchThread
        ? await this.deps.fetchThread(threadId, username)
        : await import("../providers/instagram.ts").then(({ fetchThreadMessages }) =>
            fetchThreadMessages(threadId, "", username),
          );
      const sourceFetchedAt = new Date().toISOString();
      store.setCursor("instagram", username, "last_success_at", sourceFetchedAt);
      store.setCursor("instagram", username, "last_error_class", "");
      store.setCursor("instagram", username, "cooldown_until", "");
      if (messages.length > 0) {
        const { upsertFullMessages } = await import("../store.ts");
        const incoming = messages.filter((m) => m.from?.address !== "me");
        const outgoing = messages.filter((m) => m.from?.address === "me");
        if (incoming.length > 0) upsertFullMessages(incoming, threadId);
        if (outgoing.length > 0) upsertFullMessages(outgoing, threadId);
      }
      return { performed: true, sourceFetchedAt };
    } catch (err) {
      const errorClass = classifyInstagramError(err);
      store.setCursor("instagram", username, "last_error_class", errorClass);
      if (shouldStartCooldown(errorClass)) {
        store.setCursor(
          "instagram",
          username,
          "cooldown_until",
          new Date(Date.now() + COOLDOWN_MS).toISOString(),
        );
      }
      throw err;
    }
  }

  async fetchThreadDelta(req: {
    threadId: string;
    username: string;
    anchorId?: string;
    cursor?: string;
    maxPages?: number;
    maxMessages?: number;
    pageLimit?: number;
  }): Promise<InstagramThreadDeltaData> {
    return this.serializeSourceRequests(() => this.fetchThreadDeltaSerialized(req));
  }

  private async fetchThreadDeltaSerialized(req: {
    threadId: string;
    username: string;
    anchorId?: string;
    cursor?: string;
    maxPages?: number;
    maxMessages?: number;
    pageLimit?: number;
  }): Promise<InstagramThreadDeltaData> {
    const now = Date.now();
    const cooldownUntil = readTime(store.getCursor("instagram", req.username, "cooldown_until"));
    if (cooldownUntil > now) return { performed: false, reason: "cooldown" };

    const messages: unknown[] = [];
    let cursor = req.cursor;
    let anchorFound = false;
    let historyExhausted = false;
    const maxPages = Math.max(1, req.maxPages ?? DEFAULT_MAX_THREAD_PAGES);
    const maxMessages = Math.max(1, req.maxMessages ?? maxPages * DEFAULT_THREAD_PAGE_LIMIT);
    const pageLimit = Math.max(1, req.pageLimit ?? DEFAULT_THREAD_PAGE_LIMIT);

    const { fetchThreadMessagesPage } = await import("../providers/instagram.ts");
    const { upsertFullMessages } = await import("../store.ts");

    let sourceFetchedAt = "";
    for (let page = 0; page < maxPages; page++) {
      if (!(await this.reserveSourceRequests(req.username, 1))) {
        return {
          performed: sourceFetchedAt !== "",
          ...(sourceFetchedAt ? { sourceFetchedAt } : { reason: "budget-exhausted" as const }),
          messages,
          anchorFound,
          historyExhausted,
          nextCursor: cursor,
          stopReason: "budget-exhausted",
        } as InstagramThreadDeltaData;
      }

      try {
        const result = await fetchThreadMessagesPage(req.threadId, "", req.username, {
          cursor,
          limit: pageLimit,
        });
        sourceFetchedAt = new Date().toISOString();
        store.setCursor("instagram", req.username, "last_success_at", sourceFetchedAt);
        store.setCursor("instagram", req.username, "last_error_class", "");
        store.setCursor("instagram", req.username, "cooldown_until", "");
        if (result.messages.length > 0) upsertFullMessages(result.messages, req.threadId);
        // instagram-cli returns display order (oldest -> newest); delta scanning needs newest first.
        for (const msg of [...result.messages].reverse()) {
          if (req.anchorId && msg.id === req.anchorId) {
            anchorFound = true;
            break;
          }
          messages.push(msg);
        }
        cursor = result.cursor;
        historyExhausted = !result.hasMore;
        if (anchorFound) {
          return {
            performed: true,
            sourceFetchedAt,
            messages,
            anchorFound,
            historyExhausted,
            nextCursor: cursor,
            stopReason: "anchor-found",
          };
        }
        if (messages.length >= maxMessages) {
          return {
            performed: true,
            sourceFetchedAt,
            messages,
            anchorFound,
            historyExhausted,
            nextCursor: cursor,
            stopReason: "message-cap",
          };
        }
        if (historyExhausted) {
          return {
            performed: true,
            sourceFetchedAt,
            messages,
            anchorFound,
            historyExhausted,
            stopReason: "history-exhausted",
          };
        }
      } catch (err) {
        const errorClass = classifyInstagramError(err);
        store.setCursor("instagram", req.username, "last_error_class", errorClass);
        if (shouldStartCooldown(errorClass)) {
          store.setCursor(
            "instagram",
            req.username,
            "cooldown_until",
            new Date(Date.now() + COOLDOWN_MS).toISOString(),
          );
        }
        throw err;
      }
    }

    return {
      performed: true,
      sourceFetchedAt,
      messages,
      anchorFound,
      historyExhausted,
      nextCursor: cursor,
      stopReason: "page-cap",
    };
  }

  isActive(): boolean {
    return this.username !== null && cliExists("instagram-cli");
  }

  statusInfo(): Record<string, unknown> {
    const config = loadConfig();
    const username = this.username ?? config.instagram?.username ?? "";
    return {
      enabled: config.daemon?.providers?.instagram?.enabled === true,
      lastAttemptAt: username ? store.getCursor("instagram", username, "last_attempt_at") : null,
      lastSuccessAt: username ? store.getCursor("instagram", username, "last_success_at") : null,
      lastErrorClass: username ? store.getCursor("instagram", username, "last_error_class") : null,
      cooldownUntil: username ? store.getCursor("instagram", username, "cooldown_until") : null,
    };
  }

  cleanup(): void {
    // Instagram has no persistent resources
  }

  ipcTypes(): string[] {
    return ["fetch-thread", "instagram-inventory", "instagram-thread-delta"];
  }

  async handleIpc(req: Record<string, unknown>): Promise<DaemonResponse | undefined> {
    if (req.type === "fetch-thread") {
      return this.handleFetchThread(req as { threadId?: string; account?: string });
    }
    if (req.type === "instagram-inventory") {
      return this.handleInventory(
        req as { account?: string; maxPages?: number; cacheOnly?: boolean },
      );
    }
    if (req.type === "instagram-thread-delta") {
      return this.handleThreadDelta(
        req as {
          threadId?: string;
          account?: string;
          anchorId?: string;
          cursor?: string;
          maxPages?: number;
          maxMessages?: number;
          pageLimit?: number;
        },
      );
    }
    return undefined;
  }

  private async handleInventory(req: {
    account?: string;
    maxPages?: number;
    cacheOnly?: boolean;
  }): Promise<DaemonResponse> {
    const username = req.account ?? this.username;
    if (!username) return { ok: false, error: "Instagram not configured" };
    try {
      const result: InstagramFetchMeta = req.cacheOnly
        ? { performed: false, reason: "cache-only" }
        : await this.actuallyFetch(username, { maxPages: req.maxPages });
      const threads = listInstagramInventoryThreads(username);
      return {
        ok: true,
        data: {
          ...result,
          ...(!result.performed
            ? {
                sourceFetchedAt:
                  store.getCursor("instagram", username, "last_success_at") ?? undefined,
              }
            : {}),
          threads,
          stopReason: result.performed ? "complete" : result.reason,
        } satisfies InstagramInventoryData,
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  private async handleThreadDelta(req: {
    threadId?: string;
    account?: string;
    anchorId?: string;
    cursor?: string;
    maxPages?: number;
    maxMessages?: number;
    pageLimit?: number;
  }): Promise<DaemonResponse> {
    if (!req.threadId) return { ok: false, error: "threadId required" };
    const username = req.account ?? this.username;
    if (!username) return { ok: false, error: "Instagram not configured" };
    try {
      const data = await this.fetchThreadDelta({
        threadId: req.threadId,
        username,
        anchorId: req.anchorId,
        cursor: req.cursor,
        maxPages: req.maxPages,
        maxMessages: req.maxMessages,
        pageLimit: req.pageLimit,
      });
      return {
        ok: true,
        data: { ...data, thread: getNormalizedInstagramThread(username, req.threadId) },
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
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
      const data = await this.actuallyFetchThread(req.threadId, username);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}
