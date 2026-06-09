/**
 * Shared WhatsApp/Baileys utilities — used by both the auth module and the daemon.
 *
 * Extracted to eliminate duplication of:
 *   - Silent pino-compatible logger
 *   - Baileys socket creation boilerplate
 *   - WhatsApp directory path constants
 */

import { join } from "node:path";
import makeWASocket, {
  type AuthenticationCreds,
  Browsers,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  type proto,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";

import { getConfigDir } from "../config.ts";
import { validateAttachment } from "../shared/attachment-validation.ts";
import { writeMedia } from "../shared/media-store.ts";
import { decideAudioAttachment } from "../shared/whatsapp-audio-decision.ts";
import * as store from "../store.ts";
import type { Attachment, MessageFull } from "../types.ts";

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
// Message type helpers
// ---------------------------------------------------------------------------

/**
 * Check if a normalized Baileys message is an audio message.
 *
 * Returns true for both regular audio messages and push-to-talk (PTT) voice notes.
 * PTT is indicated by the `ptt` field within the audioMessage.
 *
 * @param normalized The normalized message content from Baileys
 * @returns true if the message has an audioMessage field
 */
export function isAudioMessage(normalized: proto.IMessage | null | undefined): boolean {
  if (!normalized) return false;
  return !!normalized.audioMessage;
}

// ---------------------------------------------------------------------------
// Socket factory
// ---------------------------------------------------------------------------

export interface CreateSocketResult {
  sock: WASocket;
  saveCreds: () => Promise<void>;
  creds: AuthenticationCreds;
}

export interface WhatsAppOwnerIdentity {
  id?: string;
  name?: string;
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
      // biome-ignore lint/suspicious/noExplicitAny: Baileys expects pino-compatible logger, our silent logger is compatible
      keys: makeCacheableSignalKeyStore(state.keys, silentLogger as any),
    },
    printQRInTerminal: false,
    browser: Browsers.macOS("Chrome"),
    // biome-ignore lint/suspicious/noExplicitAny: Baileys expects pino-compatible logger, our silent logger is compatible
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
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid);
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

export function bareAddressFromJid(jid: string | undefined): string | undefined {
  if (!jid) return undefined;
  const user = jid.split("@")[0] || jid;
  return user.split(":")[0] || user;
}

function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
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
 * @param groupName  Optional group name for group messages
 * @param contactNames  Optional contact name map for display names
 * @param isHistorySync  If true, skip eager audio downloads (default: false)
 * @returns true if the message was stored, false if skipped
 */
export async function parseAndStoreWAMessage(
  msg: WAMessage,
  sock?: WASocket,
  lidCache?: Map<string, string>,
  groupName?: string,
  contactNames?: Map<string, string>,
  isHistorySync = false,
  ownerIdentity?: WhatsAppOwnerIdentity,
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

    // Allow voice-only messages (no caption) to pass through
    // Voice notes have audioMessage/pttMessage but often no text content
    if (!content && !isAudioMessage(normalized)) return false;

    const ownerAddress =
      bareAddressFromJid(sock?.user?.id) ?? bareAddressFromJid(ownerIdentity?.id);
    const ownerProfileName = sock?.user?.name || ownerIdentity?.name;
    const ownerName = ownerProfileName || ownerAddress || "me";

    // Determine sender info
    let senderJid = chatJid;
    if (msg.key.participant) {
      senderJid = await translateJid(msg.key.participant, sock, lidCache);
    }
    const senderAddress = bareAddressFromJid(senderJid) ?? senderJid;
    // Resolve the sender name authoritatively. The contacts-table-backed map wins;
    // pushName is only trusted when it does NOT look like the owner's own name on a
    // message whose sender is NOT the owner (Baileys leaks the owner's pushName onto
    // contact-authored messages during linked-device/history sync). Anchor on the
    // sender ADDRESS, never the display name (real contacts may share the owner's name).
    const senderContactName = contactNames?.get(senderAddress);
    const senderIsOwner = !!ownerAddress && senderAddress === ownerAddress;
    const pushNameLooksLikeOwner = namesMatch(msg.pushName, ownerProfileName);
    const safePushName =
      msg.pushName && !(pushNameLooksLikeOwner && !senderIsOwner) ? msg.pushName : undefined;
    const senderName = senderContactName ?? safePushName ?? senderAddress;
    const recipientAddress = bareAddressFromJid(chatJid) ?? chatJid;
    const recipientName = contactNames?.get(recipientAddress);

    const participantIsOwner =
      !!ownerAddress && !!msg.key.participant && senderAddress === ownerAddress;
    const displayNameIdentifiesOwner =
      !!ownerAddress &&
      !!ownerProfileName &&
      ownerProfileName !== ownerAddress &&
      !!recipientName &&
      !namesMatch(recipientName, ownerProfileName) &&
      namesMatch(msg.pushName, ownerProfileName);

    const inferredOwnerAuthoredHistory =
      isHistorySync && !isGroup && !fromMe && (participantIsOwner || displayNameIdentifiesOwner);
    const authoredByOwner = fromMe || inferredOwnerAuthoredHistory;

    // Determine direction and build contacts
    const direction: "in" | "out" = authoredByOwner ? "out" : "in";
    const fromContact = authoredByOwner
      ? {
          name: ownerName,
          address: ownerAddress ?? (sock?.user || ownerIdentity ? "me" : senderAddress),
        }
      : {
          name: senderName,
          address: senderAddress,
        };

    // For outgoing messages, the "to" is the chat; for incoming, "to" is self
    const toContact = authoredByOwner
      ? {
          name: recipientName ?? recipientAddress,
          address: recipientAddress,
        }
      : !isGroup && ownerAddress
        ? { name: ownerName, address: ownerAddress }
        : { name: "me", address: "me" };

    const timestamp =
      typeof msg.messageTimestamp === "number"
        ? msg.messageTimestamp
        : Number(msg.messageTimestamp);

    // Eager audio download (v1: audio only, not image/video)
    const attachments: Attachment[] = [];
    let hasAttachments = false;

    if (isAudioMessage(normalized)) {
      const audioMsg = normalized.audioMessage;
      if (audioMsg) {
        hasAttachments = true;

        const fileLength = audioMsg.fileLength ? Number(audioMsg.fileLength) : 0;

        // Use pure decision logic to determine whether to download
        const decision = decideAudioAttachment({ fileLength, isHistorySync });

        if (decision.action === "skip") {
          // Don't download - mark as unavailable with reason
          attachments.push({
            filename: `${msg.key.id}.ogg`,
            contentType: "audio/ogg",
            size: fileLength,
            unavailable: decision.reason,
          });
        } else {
          // Attempt download
          try {
            const bytes = await downloadMediaMessage(msg, "buffer", {});

            // Check for 0-byte download (network blip, expired URL, decryption failure)
            if (bytes.length === 0) {
              process.stderr.write(
                `[whatsapp] 0-byte download for ${msg.key.id} - marking unavailable\n`,
              );
              attachments.push({
                filename: `${msg.key.id}.ogg`,
                contentType: "audio/ogg",
                size: fileLength,
                unavailable: "download-empty",
              });
            } else {
              const msgId = msg.key.id || `wa-${Date.now()}`;

              // writeMedia will throw if msgId contains path traversal attempts
              const path = await writeMedia("whatsapp", msgId, "ogg", bytes);

              const attachment: Attachment = {
                filename: `${msgId}.ogg`,
                contentType: "audio/ogg",
                size: bytes.length,
                path,
              };

              // Validate the attachment follows the three-state invariant
              validateAttachment(attachment, { attachmentsRequested: true });
              attachments.push(attachment);
            }
          } catch (err) {
            // Download failed OR invalid msgId (path traversal attempt)
            const errorMsg = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `[whatsapp] audio download failed for ${msg.key.id}: ${errorMsg}\n`,
            );

            // Distinguish between invalid-msg-id and general download failure
            const unavailableReason = errorMsg.includes("Invalid message ID")
              ? "invalid-msg-id"
              : "download-failed";

            attachments.push({
              filename: `${msg.key.id}.ogg`,
              contentType: "audio/ogg",
              size: fileLength,
              unavailable: unavailableReason,
            });
          }
        }
      }
    }

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
      unread: !authoredByOwner,
      hasAttachments,
      isGroup,
      groupName: isGroup ? (groupName ?? chatJid.split("@")[0]) : undefined,
      attachments,
      direction,
    };

    store.upsertFullMessages([full]);
    return true;
  } catch (err) {
    process.stderr.write(`[whatsapp] error processing message: ${err}\n`);
    return false;
  }
}
