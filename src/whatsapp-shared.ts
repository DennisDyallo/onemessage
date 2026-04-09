/**
 * Shared WhatsApp/Baileys utilities — used by both the auth module and the daemon.
 *
 * Extracted to eliminate duplication of:
 *   - Silent pino-compatible logger
 *   - Baileys socket creation boilerplate
 *   - WhatsApp directory path constants
 */

import { join } from "path";
import makeWASocket, {
  Browsers,
  type AuthenticationCreds,
  type WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

import { getConfigDir } from "./config.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const WA_DIR = join(getConfigDir(), "whatsapp");
export const PID_PATH = join(WA_DIR, "daemon.pid");
export const SOCK_PATH = join(WA_DIR, "daemon.sock");
export const AUTH_DIR = join(WA_DIR, "auth");

// ---------------------------------------------------------------------------
// Silent Baileys logger (pino-compatible shape)
// ---------------------------------------------------------------------------

const noop = () => {};

export const silentLogger = {
  level: "silent" as const,
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  child() {
    return silentLogger;
  },
};

// ---------------------------------------------------------------------------
// Socket factory
// ---------------------------------------------------------------------------

export interface CreateSocketResult {
  sock: WASocket;
  saveCreds: () => Promise<void>;
  creds: AuthenticationCreds;
}

/**
 * Create a Baileys WASocket with standard config.
 * Handles auth state loading, version fetching, and silent logging.
 */
export async function createBaileysSocket(authDir: string): Promise<CreateSocketResult> {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestWaWebVersion({}).catch(() => ({
    version: undefined,
  }));

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silentLogger as any),
    },
    printQRInTerminal: false,
    browser: Browsers.macOS("Chrome"),
    logger: silentLogger as any,
  });

  return { sock, saveCreds, creds: state.creds };
}
