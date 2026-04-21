import { describe, expect, test } from "bun:test";
import { UnifiedDaemon } from "../../daemon.ts";
import type {
  DaemonOrchestrator,
  DaemonResponse,
  IpcCapableAdapter,
  ProviderAdapter,
} from "../../daemon-adapter.ts";

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
