/**
 * WhatsApp Authentication Module
 *
 * Runs the Baileys auth flow interactively:
 * - QR mode (default): renders QR in terminal for scanning
 * - Pairing code mode (phone provided): displays 8-digit code
 */

import { mkdirSync } from "fs";
import { join } from "path";

// @ts-ignore — qrcode-terminal has no type declarations
import qrcode from "qrcode-terminal";

import { DisconnectReason } from "@whiskeysockets/baileys";

import { getConfigDir } from "./config.ts";
import { createBaileysSocket } from "./whatsapp-shared.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WhatsAppAuthOpts {
  /** Phone number with country code (no + or spaces). Enables pairing-code mode. */
  phone?: string;
  /** Directory to store auth credentials. */
  authDir?: string;
}

/**
 * Run the WhatsApp authentication flow interactively.
 *
 * Resolves once successfully connected; rejects on unrecoverable failure.
 */
export async function runWhatsAppAuth(opts: WhatsAppAuthOpts = {}): Promise<void> {
  const authDir = opts.authDir ?? join(getConfigDir(), "whatsapp", "auth");
  mkdirSync(authDir, { recursive: true });

  console.log("Starting WhatsApp authentication...\n");

  return connectSocket(authDir, opts.phone, false);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function connectSocket(
  authDir: string,
  phone: string | undefined,
  isReconnect: boolean,
): Promise<void> {
  const { sock, saveCreds, creds } = await createBaileysSocket(authDir);

  // Request pairing code when phone is provided (only on first connect)
  if (phone && !isReconnect && !creds.me) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phone);
        console.log(`\nPairing code: ${code}\n`);
        console.log("  1. Open WhatsApp on your phone");
        console.log("  2. Tap Settings > Linked Devices > Link a Device");
        console.log('  3. Tap "Link with phone number instead"');
        console.log(`  4. Enter this code: ${code}\n`);
      } catch (err: any) {
        console.error("Failed to request pairing code:", err.message);
      }
    }, 3000);
  }

  return new Promise<void>((resolve, reject) => {
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !phone) {
        console.log("Scan this QR code with WhatsApp:\n");
        console.log("  1. Open WhatsApp on your phone");
        console.log("  2. Tap Settings > Linked Devices > Link a Device");
        console.log("  3. Point your camera at the QR code below\n");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        console.log("\nConnected! WhatsApp credentials saved.");
        // Brief delay to let final creds flush to disk
        setTimeout(() => resolve(), 500);
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;

        if (statusCode === 515) {
          // 515 stream error — common after initial pairing; reconnect once
          console.log("\nStream error (515) after pairing — reconnecting...");
          connectSocket(authDir, phone, true).then(resolve, reject);
          return;
        }

        if (statusCode === DisconnectReason.loggedOut) {
          reject(new Error("Auth failed: logged out. Delete auth directory and try again."));
          return;
        }

        if (statusCode === DisconnectReason.timedOut) {
          reject(new Error("Auth failed: QR code timed out."));
          return;
        }

        reject(new Error(`Auth failed (status ${statusCode ?? "unknown"}).`));
      }
    });
  });
}
