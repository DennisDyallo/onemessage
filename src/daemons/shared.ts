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

export type DaemonHealthState =
  | "healthy"
  | "stopped"
  | "invalid-pid"
  | "stale-pid"
  | "missing-socket"
  | "unresponsive-socket";

export interface DaemonHealth {
  state: DaemonHealthState;
  pid: number | null;
  pidFileExists: boolean;
  processAlive: boolean;
  socketExists: boolean;
  responding: boolean;
  message: string;
  suggestedCommand?: string;
}

export function classifyDaemonRuntimeState(input: {
  pid: number | null;
  pidFileExists: boolean;
  processAlive: boolean;
  socketExists: boolean;
  responding: boolean;
}): DaemonHealth {
  const { pid, pidFileExists, processAlive, socketExists, responding } = input;

  if (!pidFileExists) {
    return {
      state: "stopped",
      pid,
      pidFileExists,
      processAlive,
      socketExists,
      responding,
      message: "Daemon is not running (no PID file).",
      suggestedCommand: "onemessage daemon start",
    };
  }

  if (pid === null) {
    return {
      state: "invalid-pid",
      pid,
      pidFileExists,
      processAlive,
      socketExists,
      responding,
      message: "Daemon PID file is invalid.",
      suggestedCommand: "onemessage daemon restart",
    };
  }

  if (!processAlive) {
    return {
      state: "stale-pid",
      pid,
      pidFileExists,
      processAlive,
      socketExists,
      responding,
      message: `PID file points at ${pid}, but that process is not alive.`,
      suggestedCommand: "onemessage daemon restart",
    };
  }

  if (!socketExists) {
    return {
      state: "missing-socket",
      pid,
      pidFileExists,
      processAlive,
      socketExists,
      responding,
      message: `PID ${pid} exists, but the IPC socket is missing; daemon state is stale.`,
      suggestedCommand: "onemessage daemon restart",
    };
  }

  if (!responding) {
    return {
      state: "unresponsive-socket",
      pid,
      pidFileExists,
      processAlive,
      socketExists,
      responding,
      message: `PID ${pid} exists and socket exists, but the daemon is not responding.`,
      suggestedCommand: "onemessage daemon restart",
    };
  }

  return {
    state: "healthy",
    pid,
    pidFileExists,
    processAlive,
    socketExists,
    responding,
    message: `Daemon is healthy (pid=${pid}).`,
  };
}

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

export async function diagnoseDaemonHealth(timeoutMs = 1_000): Promise<DaemonHealth> {
  const pidFileExists = existsSync(DAEMON_PID);
  const pid = readDaemonPid();
  const processAlive = pid !== null && isProcessAlive(pid);
  const socketExists = existsSync(DAEMON_SOCK);
  const responding = socketExists ? await isDaemonResponding(timeoutMs) : false;

  return classifyDaemonRuntimeState({
    pid,
    pidFileExists,
    processAlive,
    socketExists,
    responding,
  });
}

export function formatDaemonHealth(health: DaemonHealth): string {
  const parts = [
    health.message,
    `state=${health.state}`,
    `pid=${health.pid ?? "none"}`,
    `pidFile=${health.pidFileExists ? "present" : "missing"}`,
    `socket=${health.socketExists ? DAEMON_SOCK : "missing"}`,
    `responding=${health.responding ? "yes" : "no"}`,
  ];
  if (health.suggestedCommand) parts.push(`try: ${health.suggestedCommand}`);
  return parts.join("; ");
}

export function launchdServiceTarget(): string {
  const uid = process.getuid?.();
  return uid === undefined ? "com.onemessage.daemon" : `gui/${uid}/com.onemessage.daemon`;
}

export function restartDaemonViaLaunchctl(): boolean {
  const plist = `${process.env.HOME}/Library/LaunchAgents/com.onemessage.daemon.plist`;
  if (!existsSync(plist)) return false;

  const kick = Bun.spawnSync(["launchctl", "kickstart", "-k", launchdServiceTarget()], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (kick.exitCode === 0) return true;

  Bun.spawnSync(["launchctl", "unload", plist], { stdio: ["ignore", "inherit", "inherit"] });
  Bun.spawnSync(["launchctl", "load", plist], { stdio: ["ignore", "inherit", "inherit"] });
  return true;
}

// ---------------------------------------------------------------------------
// IPC client
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: IPC response shape varies by request type
export function daemonRequest(req: object, opts?: { timeoutMs?: number }): Promise<any> {
  return new Promise((resolve, reject) => {
    let socket: ReturnType<typeof connect> | null = null;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    const timeout = setTimeout(() => {
      if (socket) socket.destroy();
      const pid = readDaemonPid();
      const health = classifyDaemonRuntimeState({
        pid,
        pidFileExists: existsSync(DAEMON_PID),
        processAlive: pid !== null && isProcessAlive(pid),
        socketExists: existsSync(DAEMON_SOCK),
        responding: false,
      });
      finish(() =>
        reject(
          new Error(
            `Daemon request timed out (${opts?.timeoutMs ?? 30_000}ms). ${formatDaemonHealth(health)}`,
          ),
        ),
      );
    }, opts?.timeoutMs ?? 30_000);

    socket = connect(DAEMON_SOCK, () => {
      socket?.write(`${JSON.stringify(req)}\n`);
    });

    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      const newlineIdx = data.indexOf("\n");
      if (newlineIdx === -1) return;

      const frame = data.slice(0, newlineIdx).trim();
      if (!frame) return;
      finish(() => {
        try {
          resolve(JSON.parse(frame));
        } catch {
          reject(new Error(`Invalid JSON from daemon: ${frame.slice(0, 200)}`));
        }
      });
    });

    socket.on("end", () => {
      finish(() => {
        try {
          resolve(JSON.parse(data.trim()));
        } catch {
          reject(new Error(`Invalid JSON from daemon: ${data.slice(0, 200)}`));
        }
      });
    });

    socket.on("error", (err) => {
      finish(() => reject(err));
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

    if (restartDaemonViaLaunchctl()) {
      const restartDeadline = Date.now() + 10_000;
      while (Date.now() < restartDeadline) {
        if (isDaemonRunning() && (await isDaemonResponding())) return;
        await new Promise((r) => setTimeout(r, 200));
      }
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

  const health = await diagnoseDaemonHealth();
  throw new Error(`Daemon failed to start within 10 seconds. ${formatDaemonHealth(health)}`);
}
