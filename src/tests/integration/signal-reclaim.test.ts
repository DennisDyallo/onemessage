/**
 * Behavioral tests for the Signal stale-socket reconciliation logic
 * (probe / reclaim / reap). These test the REAL exported functions via injected
 * seams and a real `node:net` UNIX socket — they NEVER spawn signal-cli.
 *
 * See Plans/playful-meandering-lighthouse.md §2 for the design + audit trail.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSignalCliForAccount,
  probeSignalSocket,
  reapSignalOrphan,
  reclaimSignalSocket,
  type SignalLiveness,
} from "../../providers/signal.ts";

const ACCOUNT = "+46700000000";
let tmp = "";
const servers: Server[] = [];

function tempDir(): string {
  tmp = mkdtempSync(join(tmpdir(), "om-signal-reclaim-"));
  return tmp;
}

function listenOn(path: string): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer();
    servers.push(srv);
    srv.listen(path, () => resolve(srv));
  });
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((r) => s.close(() => r()));
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

// ---------------------------------------------------------------------------
// probeSignalSocket — real sockets
// ---------------------------------------------------------------------------

describe("probeSignalSocket", () => {
  test('returns "accepting" for a live listener', async () => {
    const dir = tempDir();
    const sock = join(dir, "live.sock");
    await listenOn(sock);
    expect(await probeSignalSocket(sock)).toBe("accepting");
  });

  test('returns "dead" for an absent path', async () => {
    const dir = tempDir();
    expect(await probeSignalSocket(join(dir, "nope.sock"))).toBe("dead");
  });
});

// ---------------------------------------------------------------------------
// reclaimSignalSocket — seam-driven, deterministic
// ---------------------------------------------------------------------------

describe("reclaimSignalSocket", () => {
  const deadProbe = async (): Promise<SignalLiveness> => "dead";
  const acceptingProbe = async (): Promise<SignalLiveness> => "accepting";
  const uncertainProbe = async (): Promise<SignalLiveness> => "uncertain";

  test('reaps a live ours-orphan first → "clear" when reap succeeds', async () => {
    const dir = tempDir();
    let reaped = false;
    const result = await reclaimSignalSocket(
      ACCOUNT,
      join(dir, "x.sock"),
      acceptingProbe,
      () => true, // isOurs
      () => 4242, // recordedPid
      async () => {
        reaped = true;
        return true;
      },
    );
    expect(reaped).toBe(true);
    expect(result).toBe("clear");
  });

  test('live ours-orphan → "busy" when reap fails', async () => {
    const dir = tempDir();
    const result = await reclaimSignalSocket(
      ACCOUNT,
      join(dir, "x.sock"),
      acceptingProbe,
      () => true,
      () => 4242,
      async () => false,
    );
    expect(result).toBe("busy");
  });

  test('absent socket with no live token → "clear"', async () => {
    const dir = tempDir();
    const result = await reclaimSignalSocket(
      ACCOUNT,
      join(dir, "absent.sock"),
      deadProbe,
      () => false,
      () => null,
    );
    expect(result).toBe("clear");
  });

  test('foreign live listener (not our token) → "busy", file kept', async () => {
    const dir = tempDir();
    const sock = join(dir, "foreign.sock");
    writeFileSync(sock, ""); // existsSync → true
    const result = await reclaimSignalSocket(
      ACCOUNT,
      sock,
      acceptingProbe,
      () => false, // even if a token existed, identity fails
      () => 999,
    );
    expect(result).toBe("busy");
    expect(existsSync(sock)).toBe(true);
  });

  test('uncertain probe → "busy", file kept', async () => {
    const dir = tempDir();
    const sock = join(dir, "uncertain.sock");
    writeFileSync(sock, "");
    const result = await reclaimSignalSocket(
      ACCOUNT,
      sock,
      uncertainProbe,
      () => false,
      () => null,
    );
    expect(result).toBe("busy");
    expect(existsSync(sock)).toBe(true);
  });

  test('dead stub (probe dead) → unlinks and returns "clear"', async () => {
    const dir = tempDir();
    const sock = join(dir, "stub.sock");
    writeFileSync(sock, ""); // a stale file with no listener
    const result = await reclaimSignalSocket(
      ACCOUNT,
      sock,
      deadProbe,
      () => false,
      () => null,
    );
    expect(result).toBe("clear");
    expect(existsSync(sock)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reapSignalOrphan — seam-driven
// ---------------------------------------------------------------------------

describe("reapSignalOrphan", () => {
  test("re-verifies identity before kill; never kills a non-ours pid", async () => {
    const dir = tempDir();
    let killed = false;
    const ok = await reapSignalOrphan(
      4242,
      ACCOUNT,
      join(dir, "x.sock"),
      () => false, // isOurs → not ours
      async () => "dead",
      () => {
        killed = true;
      },
      async () => true,
    );
    expect(ok).toBe(false);
    expect(killed).toBe(false);
  });

  test("kills, confirms exit, probes dead → unlinks → true", async () => {
    const dir = tempDir();
    const sock = join(dir, "x.sock");
    writeFileSync(sock, "");
    let killed = false;
    const ok = await reapSignalOrphan(
      4242,
      ACCOUNT,
      sock,
      () => true,
      async () => "dead",
      () => {
        killed = true;
      },
      async () => true, // waitExit → exited
    );
    expect(killed).toBe(true);
    expect(ok).toBe(true);
    expect(existsSync(sock)).toBe(false);
  });

  test("process won't die → false, socket kept", async () => {
    const dir = tempDir();
    const sock = join(dir, "x.sock");
    writeFileSync(sock, "");
    const ok = await reapSignalOrphan(
      4242,
      ACCOUNT,
      sock,
      () => true,
      async () => "dead",
      () => {},
      async () => false, // never exits
    );
    expect(ok).toBe(false);
    expect(existsSync(sock)).toBe(true);
  });

  test("a replacement listener appears after kill → false, socket kept", async () => {
    const dir = tempDir();
    const sock = join(dir, "x.sock");
    writeFileSync(sock, "");
    const ok = await reapSignalOrphan(
      4242,
      ACCOUNT,
      sock,
      () => true,
      async () => "accepting", // someone is serving the path again
      () => {},
      async () => true,
    );
    expect(ok).toBe(false);
    expect(existsSync(sock)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isSignalCliForAccount — negative cases (never touch a real signal-cli)
// ---------------------------------------------------------------------------

describe("isSignalCliForAccount", () => {
  test("a dead/unused PID is never ours", () => {
    // PID 0 is not a real reapable process for our purposes; isProcessAlive(0)
    // is false in this context → predicate must return false without throwing.
    expect(isSignalCliForAccount(2_147_483_646, ACCOUNT)).toBe(false);
  });
});
