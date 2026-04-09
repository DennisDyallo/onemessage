import { registerProvider } from "../registry.ts";
import { getConfigDir } from "../config.ts";
import * as store from "../store.ts";
import { readFromCacheOrFail, cacheSentMessage } from "./shared.ts";
import type { MessagingProvider } from "../types.ts";
import { join, dirname } from "path";
import { existsSync, readFileSync } from "fs";
import { connect } from "net";
import { SOCK_PATH as SOCKET_PATH, PID_PATH, AUTH_DIR } from "../whatsapp-shared.ts";

/** Project root — used to launch the daemon with the correct cwd. */
const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), "..", "..");

// ---------------------------------------------------------------------------
// Daemon management
// ---------------------------------------------------------------------------

function isDaemonRunning(): boolean {
  if (!existsSync(PID_PATH)) return false;
  try {
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<void> {
  if (isDaemonRunning() && existsSync(SOCKET_PATH)) return;

  const proc = Bun.spawn(["bun", "run", "src/whatsapp-daemon.ts"], {
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
    if (existsSync(SOCKET_PATH) && isDaemonRunning()) return;
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
  }

  throw new Error("WhatsApp daemon failed to start within 10 seconds");
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function daemonRequest(req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("WhatsApp daemon request timed out (30s)"));
    }, 30_000);

    const socket = connect(SOCKET_PATH, () => {
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
// Recipient resolution
// ---------------------------------------------------------------------------

async function recipientToJid(recipientId: string): Promise<string | null> {
  // Phone number: +46... → 46...@s.whatsapp.net
  if (recipientId.startsWith("+")) {
    return recipientId.slice(1) + "@s.whatsapp.net";
  }

  // Group: group:name or group:12345678
  if (recipientId.startsWith("group:")) {
    const groupRef = recipientId.slice(6);
    // Purely numeric → direct group JID
    if (/^\d+$/.test(groupRef)) {
      return groupRef + "@g.us";
    }
    // Name lookup via daemon
    const res = await daemonRequest({ type: "resolve-group", name: groupRef });
    return res?.data?.id ?? null;
  }

  // Already a raw JID (contains @)
  if (recipientId.includes("@")) {
    return recipientId;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const whatsappProvider: MessagingProvider = {
  name: "whatsapp",
  displayName: "WhatsApp (Baileys)",

  isConfigured() {
    return existsSync(join(AUTH_DIR, "creds.json"));
  },

  async send(recipientId, body, opts) {
    await ensureDaemon();
    const jid = await recipientToJid(recipientId);
    if (!jid) {
      return { ok: false, provider: "whatsapp", recipientId, error: "Invalid recipient" };
    }

    const res = await daemonRequest({ type: "send", jid, text: body });

    if (res.ok) {
      cacheSentMessage({
        provider: "whatsapp",
        fromAddress: "me",
        recipientId,
        body,
      });
      return {
        ok: true,
        provider: "whatsapp",
        recipientId,
        messageId: res.data?.messageId,
      };
    }

    return { ok: false, provider: "whatsapp", recipientId, error: res.error };
  },

  async inbox(opts) {
    if (!store.isFresh("whatsapp", 60_000) || opts?.providerFlags?.fresh) {
      try {
        await ensureDaemon();
      } catch {}
      store.recordFetch("whatsapp");
    }

    return store.getCachedInbox("whatsapp", {
      limit: opts?.limit,
      unread: opts?.unread,
      since: opts?.since,
      from: opts?.from,
    });
  },

  async read(messageId, opts) {
    return readFromCacheOrFail("whatsapp", messageId);
  },

  async search(query, opts) {
    return store.searchCached(query, "whatsapp", {
      limit: opts?.limit,
      since: opts?.since,
    });
  },
};

registerProvider(whatsappProvider);
