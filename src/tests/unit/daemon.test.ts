import { describe, expect, test } from "bun:test";
import type {
  DaemonOrchestrator,
  DaemonResponse,
  IpcCapableAdapter,
  ProviderAdapter,
} from "../../daemons/adapter.ts";
import { UnifiedDaemon } from "../../daemons/daemon.ts";

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

class StubAdapter implements ProviderAdapter {
  readonly name: string;
  readonly polling = true;
  private active: boolean;
  fetchCalled = false;

  constructor(name: string, active = true) {
    this.name = name;
    this.active = active;
  }
  start(_o: DaemonOrchestrator) {}
  async fetch() {
    this.fetchCalled = true;
  }
  isActive() {
    return this.active;
  }
  statusInfo() {
    return {};
  }
  cleanup() {}
}

class StubIpcAdapter implements IpcCapableAdapter {
  readonly name: string;
  readonly polling = false;

  constructor(name: string) {
    this.name = name;
  }
  start(_o: DaemonOrchestrator) {}
  async fetch() {}
  isActive() {
    return true;
  }
  statusInfo() {
    return { connected: true };
  }
  cleanup() {}
  ipcTypes() {
    return ["custom-action"];
  }
  async handleIpc(req: Record<string, unknown>): Promise<DaemonResponse | undefined> {
    if (req.type === "custom-action") return { ok: true, data: "handled" };
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daemon IPC dispatch", () => {
  test("invalid JSON returns error", async () => {
    const daemon = new UnifiedDaemon([new StubAdapter("a")]);
    const res = await daemon.processIpc("not json{{{");
    expect(res).toEqual({ ok: false, error: "invalid JSON" });
  });

  test("ping returns ok", async () => {
    const daemon = new UnifiedDaemon([new StubAdapter("a")]);
    const res = await daemon.processIpc(JSON.stringify({ type: "ping" }));
    expect(res).toEqual({ ok: true });
  });

  test("status returns structure with pid, uptime, polling", async () => {
    const daemon = new UnifiedDaemon([new StubAdapter("sig", true)]);
    const res = await daemon.processIpc(JSON.stringify({ type: "status" }));
    expect(res.ok).toBe(true);
    const data = (res as { ok: true; data: Record<string, unknown> }).data;
    expect(data.pid).toBe(process.pid);
    expect(typeof data.uptime).toBe("number");
    expect(data.polling).toBeDefined();
  });

  test("status separates real-time from polling adapters", async () => {
    const poller = new StubAdapter("sig", true);
    const realtime = new StubIpcAdapter("wa");
    const daemon = new UnifiedDaemon([poller, realtime]);
    const res = await daemon.processIpc(JSON.stringify({ type: "status" }));
    const data = (res as { ok: true; data: Record<string, unknown> }).data;
    // real-time adapter appears at top level
    expect(data.wa).toBeDefined();
    // polling adapter appears inside polling object
    const polling = data.polling as Record<string, unknown>;
    expect(polling.sig).toBeDefined();
    expect(polling.wa).toBeUndefined();
  });

  test("fetch with unknown provider returns error", async () => {
    const daemon = new UnifiedDaemon([new StubAdapter("a")]);
    const res = await daemon.processIpc(JSON.stringify({ type: "fetch", provider: "nope" }));
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain("nope");
  });

  test("fetch with inactive provider returns not configured", async () => {
    const inactive = new StubAdapter("dead", false);
    const daemon = new UnifiedDaemon([inactive]);
    const res = await daemon.processIpc(JSON.stringify({ type: "fetch", provider: "dead" }));
    expect(res.ok).toBe(false);
    expect((res as { ok: false; error: string }).error).toContain("not configured");
  });

  test("fetch with active provider calls adapter.fetch() and returns ok", async () => {
    const stub = new StubAdapter("sig");
    const daemon = new UnifiedDaemon([stub]);
    const res = await daemon.processIpc(JSON.stringify({ type: "fetch", provider: "sig" }));
    expect(res.ok).toBe(true);
    expect(stub.fetchCalled).toBe(true);
  });

  test("fetch without provider calls fetch on all active adapters", async () => {
    const a = new StubAdapter("a", true);
    const b = new StubAdapter("b", true);
    const c = new StubAdapter("c", false);
    const daemon = new UnifiedDaemon([a, b, c]);
    const res = await daemon.processIpc(JSON.stringify({ type: "fetch" }));
    expect(res.ok).toBe(true);
    expect(a.fetchCalled).toBe(true);
    expect(b.fetchCalled).toBe(true);
    expect(c.fetchCalled).toBe(false);
  });

  test("providers returns all adapters with enabled/polling/lastPoll", async () => {
    const a = new StubAdapter("sig", true);
    const b = new StubAdapter("email", false);
    const daemon = new UnifiedDaemon([a, b]);
    const res = await daemon.processIpc(JSON.stringify({ type: "providers" }));
    expect(res.ok).toBe(true);
    const data = (res as { ok: true; data: Record<string, unknown> }).data as Record<
      string,
      { enabled: boolean; polling: boolean; lastPoll: string | null }
    >;
    expect(data.sig?.enabled).toBe(true);
    expect(data.email?.enabled).toBe(false);
    expect(data.sig?.lastPoll).toBeNull();
    expect(typeof data.sig?.polling).toBe("boolean");
  });

  test("unknown type delegates to IpcCapableAdapter and returns its response", async () => {
    const ipc = new StubIpcAdapter("wa");
    const daemon = new UnifiedDaemon([ipc]);
    const res = await daemon.processIpc(JSON.stringify({ type: "custom-action" }));
    expect(res).toEqual({ ok: true, data: "handled" });
  });
});

// ---------------------------------------------------------------------------
// pollProvider in-flight deduplication
// ---------------------------------------------------------------------------

class CountingAdapter implements ProviderAdapter {
  readonly name: string;
  readonly polling = true;
  fetchCount = 0;
  shouldThrow = false;

  constructor(name: string) {
    this.name = name;
  }
  start(_o: DaemonOrchestrator) {}
  async fetch() {
    this.fetchCount++;
    if (this.shouldThrow) throw new Error("fetch failed");
    // Simulate async work
    await new Promise((r) => setTimeout(r, 50));
  }
  isActive() {
    return true;
  }
  statusInfo() {
    return {};
  }
  cleanup() {}
}

describe("pollProvider in-flight deduplication", () => {
  test("coalesces concurrent fetches on same adapter", async () => {
    const adapter = new CountingAdapter("test-dedup");
    const daemon = new UnifiedDaemon([adapter]);

    // Spawn 5 concurrent IPC fetch requests
    const promises = Array.from({ length: 5 }, () =>
      daemon.processIpc(JSON.stringify({ type: "fetch", provider: "test-dedup" })),
    );

    const results = await Promise.all(promises);

    // All should succeed
    for (const res of results) {
      expect(res.ok).toBe(true);
    }

    // But fetch should only be called once due to deduplication
    expect(adapter.fetchCount).toBe(1);
  });

  test("releases inflight map slot after settlement", async () => {
    const adapter = new CountingAdapter("test-seq");
    const daemon = new UnifiedDaemon([adapter]);

    // First fetch
    const res1 = await daemon.processIpc(JSON.stringify({ type: "fetch", provider: "test-seq" }));
    expect(res1.ok).toBe(true);
    expect(adapter.fetchCount).toBe(1);

    // Second fetch (sequential) — should trigger a new fetch, not reuse
    const res2 = await daemon.processIpc(JSON.stringify({ type: "fetch", provider: "test-seq" }));
    expect(res2.ok).toBe(true);
    expect(adapter.fetchCount).toBe(2);
  });

  test("propagates rejection to all in-flight callers", async () => {
    const adapter = new CountingAdapter("test-fail");
    adapter.shouldThrow = true;
    const daemon = new UnifiedDaemon([adapter]);

    // Spawn 5 concurrent fetch requests
    const promises = Array.from({ length: 5 }, () =>
      daemon.processIpc(JSON.stringify({ type: "fetch", provider: "test-fail" })),
    );

    const results = await Promise.all(promises);

    // All should fail with the same error
    for (const res of results) {
      expect(res.ok).toBe(false);
      expect((res as { ok: false; error: string }).error).toContain("fetch failed");
    }

    // Fetch should only be called once
    expect(adapter.fetchCount).toBe(1);
  });

  test("clears inflight map when fetchFn throws synchronously", async () => {
    const daemon = new UnifiedDaemon([]);
    let callCount = 0;
    const syncThrowFn = () => {
      callCount++;
      throw new Error("sync boom");
    };

    // First call should reject and clean up
    await expect((daemon as any).pollProvider("__test_sync_throw__", syncThrowFn)).rejects.toThrow(
      "sync boom",
    );

    // Map must be empty for this provider — otherwise next call would reuse rejected promise
    expect((daemon as any).inflightFetches.get("__test_sync_throw__")).toBeUndefined();

    // Second call must INVOKE fn again (would not if rejected promise was cached)
    await expect((daemon as any).pollProvider("__test_sync_throw__", syncThrowFn)).rejects.toThrow(
      "sync boom",
    );
    expect(callCount).toBe(2);
  });

  test("clears inflight map when fetchFn rejects synchronously", async () => {
    const daemon = new UnifiedDaemon([]);
    let callCount = 0;
    const syncRejectFn = () => {
      callCount++;
      return Promise.reject(new Error("sync reject"));
    };

    // First call should reject and clean up
    await expect(
      (daemon as any).pollProvider("__test_sync_reject__", syncRejectFn),
    ).rejects.toThrow("sync reject");

    // Map must be empty
    expect((daemon as any).inflightFetches.get("__test_sync_reject__")).toBeUndefined();

    // Second call must INVOKE fn again
    await expect(
      (daemon as any).pollProvider("__test_sync_reject__", syncRejectFn),
    ).rejects.toThrow("sync reject");
    expect(callCount).toBe(2);
  });
});
