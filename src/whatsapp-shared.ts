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
  type WAMessage,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

import { getConfigDir } from "./config.ts";
import * as store from "./store.ts";
import type { MessageFull } from "./types.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const WA_DIR = join(getConfigDir(), "whatsapp");
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

// ---------------------------------------------------------------------------
// Shared WhatsApp message parser + store writer
// ---------------------------------------------------------------------------

/**
 * Translate a JID that may use the @lid domain into a phone-based JID.
 * When a WASocket is provided, attempts signalRepository LID lookup;
 * otherwise falls back to the raw JID.
 */
async function translateJid(
  jid: string,
  sock?: WASocket,
  lidCache?: Map<string, string>,
): Promise<string> {
  if (!jid.endsWith("@lid")) return jid;

  const lidUser = (jid.split("@")[0] || jid).split(":")[0] || jid;

  if (lidCache) {
    const cached = lidCache.get(lidUser);
    if (cached) return cached;
  }

  if (sock) {
    try {
      const pn =
        await sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${(pn.split("@")[0] || pn).split(":")[0] || pn}@s.whatsapp.net`;
        lidCache?.set(lidUser, phoneJid);
        return phoneJid;
      }
    } catch {
      // ignore resolution failure
    }
  }

  return jid;
}

/**
 * Parse a Baileys WAMessage and store it in the SQLite cache.
 *
 * This is the shared logic used by both the daemon (for real-time and
 * history-sync messages) and the auth flow (for initial history sync).
 *
 * @param msg    The raw WAMessage from Baileys
 * @param sock   Optional WASocket for LID-to-phone translation
 * @param lidCache  Optional Map for caching LID translations across calls
 * @returns true if the message was stored, false if skipped
 */
export async function parseAndStoreWAMessage(
  msg: WAMessage,
  sock?: WASocket,
  lidCache?: Map<string, string>,
  groupName?: string,
): Promise<boolean> {
  try {
    if (!msg.message) return false;
    const normalized = normalizeMessageContent(msg.message);
    if (!normalized) return false;

    const rawJid = msg.key.remoteJid;
    if (!rawJid || rawJid === "status@broadcast") return false;

    const chatJid = await translateJid(rawJid, sock, lidCache);
    const isGroup = chatJid.endsWith("@g.us");
    const fromMe = msg.key.fromMe ?? false;

    const content =
      normalized.conversation ||
      normalized.extendedTextMessage?.text ||
      normalized.imageMessage?.caption ||
      normalized.videoMessage?.caption ||
      "";

    if (!content) return false;

    // Determine sender info
    let senderJid = chatJid;
    if (msg.key.participant) {
      senderJid = await translateJid(msg.key.participant, sock, lidCache);
    }
    const senderName =
      msg.pushName || senderJid.split("@")[0] || senderJid;
    const senderAddress = senderJid.split("@")[0] || senderJid;

    // Determine direction and build contacts
    const direction: "in" | "out" = fromMe ? "out" : "in";
    const fromContact = {
      name: senderName,
      address: senderAddress,
    };

    // For outgoing messages, the "to" is the chat; for incoming, "to" is self
    const toContact = fromMe
      ? {
          name: chatJid.split("@")[0] || chatJid,
          address: chatJid.split("@")[0] || chatJid,
        }
      : { name: "me", address: "me" };

    const timestamp =
      typeof msg.messageTimestamp === "number"
        ? msg.messageTimestamp
        : Number(msg.messageTimestamp);

    const full: MessageFull = {
      id: msg.key.id || `wa-${Date.now()}`,
      provider: "whatsapp",
      from: fromContact,
      to: [toContact],
      subject: undefined,
      preview: content.slice(0, 200),
      body: content,
      bodyFormat: "text",
      date: new Date(timestamp * 1000).toISOString(),
      unread: !fromMe,
      hasAttachments: false,
      isGroup,
      groupName: isGroup ? (groupName ?? chatJid.split("@")[0]) : undefined,
      attachments: [],
      direction,
    };

    store.upsertFullMessages([full]);
    return true;
  } catch (err) {
    process.stderr.write(
      `[whatsapp] error processing message: ${err}\n`,
    );
    return false;
  }
}
