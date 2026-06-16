/**
 * Shared daemon constants and client utilities.
 *
 * Used by providers (e.g. whatsapp.ts) to communicate with the unified daemon,
 * and by daemon.ts itself for PID/socket paths.
 */

import { existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const DAEMON_PID = join(getConfigDir(), "daemon.pid");
export const DAEMON_SOCK = join(getConfigDir(), "daemon.sock");

// ---------------------------------------------------------------------------
// Daemon status
// ---------------------------------------------------------------------------

export function readDaemonPid(): number | null {
  if (!existsSync(DAEMON_PID)) return null;
  try {
    const pid = parseInt(readFileSync(DAEMON_PID, "utf-8").trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isDaemonRunning(): boolean {
  const pid = readDaemonPid();
  return pid !== null && isProcessAlive(pid);
}

// ---------------------------------------------------------------------------
// IPC client
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: IPC response shape varies by request type
export function daemonRequest(req: object, opts?: { timeoutMs?: number }): Promise<any> {
  return new Promise((resolve, reject) => {
    let socket: ReturnType<typeof connect> | null = null;
    const timeout = setTimeout(() => {
      if (socket) socket.destroy();
      reject(new Error(`Daemon request timed out (${opts?.timeoutMs ?? 30_000}ms)`));
    }, opts?.timeoutMs ?? 30_000);

    socket = connect(DAEMON_SOCK, () => {
      socket?.write(`${JSON.stringify(req)}\n`);
    });

    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });

    socket.on("end", () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error(`Invalid JSON from daemon: ${data.slice(0, 200)}`));
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export async function isDaemonResponding(timeoutMs = 1_000): Promise<boolean> {
  if (!existsSync(DAEMON_SOCK)) return false;
  try {
    const res = await daemonRequest({ type: "ping" }, { timeoutMs });
    return res?.ok === true;
  } catch {
    return false;
  }
}

export function removeStaleDaemonRuntimeFiles(): void {
  const pid = readDaemonPid();
  if (pid !== null && isProcessAlive(pid)) return;

  for (const path of [DAEMON_PID, DAEMON_SOCK]) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-start
// ---------------------------------------------------------------------------

/** Project root — used to launch the daemon with the correct cwd. */
const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");

export async function ensureDaemon(): Promise<void> {
  if (isDaemonRunning() && (await isDaemonResponding())) return;

  // A live PID with no responsive socket may be a daemon still starting, or a
  // stale PID that happens to point at another process. Give it a short chance
  // to become ready before deciding whether to spawn a new daemon.
  if (isDaemonRunning()) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await isDaemonResponding()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  removeStaleDaemonRuntimeFiles();

  // B4: redirect the detached daemon's stdout/stderr to a log file instead of
  // discarding them — silent stdio is what hid the Signal crash-loop for ~2 weeks.
  const logFd = openSync(join(getConfigDir(), "daemon.log"), "a");
  const proc = Bun.spawn(["bun", "run", "src/daemons/daemon.ts"], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  proc.unref();

  // Wait for socket to appear (poll every 200ms, max 10s)
  const maxWait = 10_000;
  const interval = 200;
  let waited = 0;
  while (waited < maxWait) {
    if (isDaemonRunning() && (await isDaemonResponding())) return;
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
  }

  throw new Error("Daemon failed to start within 10 seconds");
}
