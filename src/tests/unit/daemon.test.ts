import { describe, expect, test } from "bun:test";
import type {
  DaemonOrchestrator,
  DaemonResponse,
  IpcCapableAdapter,
  ProviderAdapter,
} from "../../daemons/adapter.ts";
import { extractIpcFrames, UnifiedDaemon } from "../../daemons/daemon.ts";
import { classifyDaemonRuntimeState } from "../../daemons/shared.ts";
import { SignalAdapter } from "../../daemons/signal.ts";

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
  test("daemon health classifies live PID with missing socket as stale missing-socket", () => {
    const health = classifyDaemonRuntimeState({
      pid: 123,
      pidFileExists: true,
      processAlive: true,
      socketExists: false,
      responding: false,
    });

    expect(health.state).toBe("missing-socket");
    expect(health.message).toContain("IPC socket is missing");
    expect(health.suggestedCommand).toBe("onemessage daemon restart");
  });

  test("daemon health classifies dead PID file as stale-pid", () => {
    const health = classifyDaemonRuntimeState({
      pid: 123,
      pidFileExists: true,
      processAlive: false,
      socketExists: false,
      responding: false,
    });

    expect(health.state).toBe("stale-pid");
    expect(health.message).toContain("not alive");
  });

  test("IPC framing buffers fragmented newline-delimited JSON frames", () => {
    const first = extractIpcFrames("", '{"type":"pi');
    expect(first.frames).toEqual([]);
    expect(first.buffer).toBe('{"type":"pi');

    const second = extractIpcFrames(first.buffer, 'ng"}\n{"type":"status"}\n');
    expect(second.frames).toEqual(['{"type":"ping"}', '{"type":"status"}']);
    expect(second.buffer).toBe("");
  });

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

  test("IPC type collision throws at construction with both owners mentioned", () => {
    class AdapterA implements IpcCapableAdapter {
      readonly name = "adapter-a";
      readonly polling = false;
      start(_o: DaemonOrchestrator) {}
      async fetch() {}
      isActive() {
        return true;
      }
      statusInfo() {
        return {};
      }
      cleanup() {}
      ipcTypes() {
        return ["dupe-type"];
      }
      async handleIpc(_req: Record<string, unknown>): Promise<DaemonResponse | undefined> {
        return { ok: true, data: "a" };
      }
    }

    class AdapterB implements IpcCapableAdapter {
      readonly name = "adapter-b";
      readonly polling = false;
      start(_o: DaemonOrchestrator) {}
      async fetch() {}
      isActive() {
        return true;
      }
      statusInfo() {
        return {};
      }
      cleanup() {}
      ipcTypes() {
        return ["dupe-type"];
      }
      async handleIpc(_req: Record<string, unknown>): Promise<DaemonResponse | undefined> {
        return { ok: true, data: "b" };
      }
    }

    expect(() => new UnifiedDaemon([new AdapterA(), new AdapterB()])).toThrow(
      /IPC type collision detected.*dupe-type.*adapter-a.*adapter-b/,
    );
  });

  test("IPC routing dispatches to correct single owner without cross-adapter leakage", async () => {
    class AdapterAlpha implements IpcCapableAdapter {
      readonly name = "alpha";
      readonly polling = false;
      handleIpcCalls = 0;
      start(_o: DaemonOrchestrator) {}
      async fetch() {}
      isActive() {
        return true;
      }
      statusInfo() {
        return {};
      }
      cleanup() {}
      ipcTypes() {
        return ["alpha-action"];
      }
      async handleIpc(req: Record<string, unknown>): Promise<DaemonResponse | undefined> {
        this.handleIpcCalls++;
        if (req.type === "alpha-action") return { ok: true, data: "alpha-handled" };
        return undefined;
      }
    }

    class AdapterBeta implements IpcCapableAdapter {
      readonly name = "beta";
      readonly polling = false;
      handleIpcCalls = 0;
      start(_o: DaemonOrchestrator) {}
      async fetch() {}
      isActive() {
        return true;
      }
      statusInfo() {
        return {};
      }
      cleanup() {}
      ipcTypes() {
        return ["beta-action"];
      }
      async handleIpc(req: Record<string, unknown>): Promise<DaemonResponse | undefined> {
        this.handleIpcCalls++;
        if (req.type === "beta-action") return { ok: true, data: "beta-handled" };
        return undefined;
      }
    }

    const adapterAlpha = new AdapterAlpha();
    const adapterBeta = new AdapterBeta();
    const daemon = new UnifiedDaemon([adapterAlpha, adapterBeta]);

    // Dispatch beta-action
    const res = await daemon.processIpc(JSON.stringify({ type: "beta-action" }));

    // Verify: only beta adapter was invoked
    expect(res).toEqual({ ok: true, data: "beta-handled" });
    expect(adapterAlpha.handleIpcCalls).toBe(0); // alpha NOT called
    expect(adapterBeta.handleIpcCalls).toBe(1); // beta called exactly once
  });
});

describe("SignalAdapter daemon freshness", () => {
  test("fetch does not mark Signal fresh when daemon handle is not running", async () => {
    const adapter = new SignalAdapter();
    (adapter as any).phone = "+46700000000";
    (adapter as any).daemonHandle = {
      running: false,
      stop() {},
    };

    await expect(adapter.fetch()).rejects.toThrow("signal daemon subprocess is not running");
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
