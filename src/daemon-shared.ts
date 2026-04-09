/**
 * Shared daemon constants and client utilities.
 *
 * Used by providers (e.g. whatsapp.ts) to communicate with the unified daemon,
 * and by daemon.ts itself for PID/socket paths.
 */

import { join, dirname } from "path";
import { existsSync, readFileSync } from "fs";
import { connect } from "net";
import { getConfigDir } from "./config.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const DAEMON_PID = join(getConfigDir(), "daemon.pid");
export const DAEMON_SOCK = join(getConfigDir(), "daemon.sock");

// ---------------------------------------------------------------------------
// Daemon status
// ---------------------------------------------------------------------------

export function isDaemonRunning(): boolean {
  if (!existsSync(DAEMON_PID)) return false;
  try {
    const pid = parseInt(readFileSync(DAEMON_PID, "utf-8").trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// IPC client
// ---------------------------------------------------------------------------

export function daemonRequest(req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Daemon request timed out (30s)"));
    }, 30_000);

    const socket = connect(DAEMON_SOCK, () => {
      socket.write(JSON.stringify(req) + "\n");
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

// ---------------------------------------------------------------------------
// Auto-start
// ---------------------------------------------------------------------------

/** Project root — used to launch the daemon with the correct cwd. */
const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");

export async function ensureDaemon(): Promise<void> {
  if (isDaemonRunning() && existsSync(DAEMON_SOCK)) return;

  const proc = Bun.spawn(["bun", "run", "src/daemon.ts"], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  proc.unref();

  // Wait for socket to appear (poll every 200ms, max 10s)
  const maxWait = 10_000;
  const interval = 200;
  let waited = 0;
  while (waited < maxWait) {
    if (existsSync(DAEMON_SOCK) && isDaemonRunning()) return;
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
  }

  throw new Error("Daemon failed to start within 10 seconds");
}
