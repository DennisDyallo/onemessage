/**
 * WhatsApp sidecar daemon — holds a persistent Baileys connection
 * and serves CLI requests over a Unix domain socket.
 *
 * Usage: bun run src/whatsapp-daemon.ts
 *
 * Runtime paths (under ~/.config/onemessage/whatsapp/):
 *   daemon.pid  — PID file
 *   daemon.sock — Unix domain socket for IPC
 *   auth/       — Baileys multi-file auth state
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import type { Server } from "bun";

import {
  DisconnectReason,
  type WASocket,
  normalizeMessageContent,
} from "@whiskeysockets/baileys";

import { loadConfig } from "./config.ts";
import * as store from "./store.ts";
import type { MessageFull } from "./types.ts";
import { WA_DIR, PID_PATH, SOCK_PATH, AUTH_DIR, createBaileysSocket } from "./whatsapp-shared.ts";

// ---------------------------------------------------------------------------
// IPC types
// ---------------------------------------------------------------------------

type DaemonRequest =
  | { type: "send"; jid: string; text: string }
  | { type: "status" }
  | { type: "resolve-group"; name: string }
  | { type: "ping" };

type DaemonResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// WhatsAppDaemon
// ---------------------------------------------------------------------------

class WhatsAppDaemon {
  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap = new Map<string, string>();
  private groupCache = new Map<string, { id: string; subject: string }>();
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;

  private unixServer: ReturnType<typeof Bun.listen> | null = null;
  private lastIpcTime = Date.now();
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimeoutMin: number;

  constructor() {
    const config = loadConfig();
    this.idleTimeoutMin = config.whatsapp?.idleTimeoutMin ?? 30;
  }

  // -----------------------------------------------------------------------
  // Start
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    mkdirSync(WA_DIR, { recursive: true });

    // Write PID file
    writeFileSync(PID_PATH, String(process.pid), "utf-8");

    // Clean up stale socket
    if (existsSync(SOCK_PATH)) {
      try {
        unlinkSync(SOCK_PATH);
      } catch {
        // ignore
      }
    }

    // Connect to WhatsApp
    await this.connectBaileys();

    // Start IPC server
    this.startIpcServer();

    // Start idle timer
    this.startIdleCheck();

    // Graceful shutdown
    process.on("SIGTERM", () => this.cleanup());
    process.on("SIGINT", () => this.cleanup());

    process.stderr.write(
      `[whatsapp-daemon] started pid=${process.pid} sock=${SOCK_PATH}\n`,
    );
  }

  // -----------------------------------------------------------------------
  // Baileys connection
  // -----------------------------------------------------------------------

  private async connectBaileys(): Promise<void> {
    mkdirSync(AUTH_DIR, { recursive: true });

    const { sock, saveCreds } = await createBaileysSocket(AUTH_DIR);
    this.sock = sock;

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        process.stderr.write(
          "[whatsapp-daemon] QR received — auth required before starting daemon. Exiting.\n",
        );
        this.cleanup();
        return;
      }

      if (connection === "close") {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const loggedOut = reason === DisconnectReason.loggedOut;

        if (loggedOut) {
          process.stderr.write(
            "[whatsapp-daemon] logged out (401). Exiting.\n",
          );
          this.cleanup();
          return;
        }

        process.stderr.write(
          `[whatsapp-daemon] connection closed (reason=${reason}), reconnecting in 5s...\n`,
        );
        setTimeout(() => {
          this.connectBaileys().catch((err) => {
            process.stderr.write(
              `[whatsapp-daemon] reconnect failed: ${err}\n`,
            );
          });
        }, 5000);
      } else if (connection === "open") {
        this.connected = true;
        process.stderr.write("[whatsapp-daemon] connected to WhatsApp\n");

        // Build self LID-to-phone mapping
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(":")[0];
          const lidUser = this.sock.user.lid?.split(":")[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap.set(lidUser, `${phoneUser}@s.whatsapp.net`);
          }
        }

        // Flush queued messages
        this.flushOutgoingQueue().catch(() => {});

        // Sync group metadata
        this.syncGroupMetadata().catch(() => {});
      }
    });

    // ---- Message reception ----
    this.sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;

          const rawJid = msg.key.remoteJid;
          if (!rawJid || rawJid === "status@broadcast") continue;

          const chatJid = await this.translateJid(rawJid);
          const fromMe = msg.key.fromMe ?? false;

          const content =
            normalized.conversation ||
            normalized.extendedTextMessage?.text ||
            normalized.imageMessage?.caption ||
            normalized.videoMessage?.caption ||
            "";

          if (!content) continue;

          // Determine sender info
          let senderJid = chatJid;
          if (msg.key.participant) {
            senderJid = await this.translateJid(msg.key.participant);
          }
          const senderName = msg.pushName || senderJid.split("@")[0] || senderJid;
          const senderAddress = senderJid.split("@")[0] || senderJid;

          // Determine direction and build contacts
          const direction: "in" | "out" = fromMe ? "out" : "in";
          const fromContact = {
            name: senderName,
            address: senderAddress,
          };

          // For outgoing messages, the "to" is the chat; for incoming, "to" is self
          const toContact = fromMe
            ? { name: chatJid.split("@")[0] || chatJid, address: chatJid.split("@")[0] || chatJid }
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
            attachments: [],
          };

          store.upsertFullMessages([full], direction);
        } catch (err) {
          process.stderr.write(
            `[whatsapp-daemon] error processing message: ${err}\n`,
          );
        }
      }
    });
  }

  // -----------------------------------------------------------------------
  // JID translation (LID -> phone)
  // -----------------------------------------------------------------------

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith("@lid")) return jid;
    const lidUser = (jid.split("@")[0] || jid).split(":")[0] || jid;

    const cached = this.lidToPhoneMap.get(lidUser);
    if (cached) return cached;

    try {
      const pn =
        await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${(pn.split("@")[0] || pn).split(":")[0] || pn}@s.whatsapp.net`;
        this.lidToPhoneMap.set(lidUser, phoneJid);
        return phoneJid;
      }
    } catch {
      // ignore resolution failure
    }

    return jid;
  }

  // -----------------------------------------------------------------------
  // Group metadata
  // -----------------------------------------------------------------------

  private async syncGroupMetadata(): Promise<void> {
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      this.groupCache.clear();
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          this.groupCache.set(jid, { id: jid, subject: metadata.subject });
        }
      }
      process.stderr.write(
        `[whatsapp-daemon] synced ${this.groupCache.size} groups\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[whatsapp-daemon] group sync failed: ${err}\n`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Outgoing queue
  // -----------------------------------------------------------------------

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sock.sendMessage(item.jid, { text: item.text });
      }
    } finally {
      this.flushing = false;
    }
  }

  // -----------------------------------------------------------------------
  // IPC server (Unix domain socket)
  // -----------------------------------------------------------------------

  private startIpcServer(): void {
    const self = this;

    this.unixServer = Bun.listen({
      unix: SOCK_PATH,
      socket: {
        data(socket, data) {
          self.lastIpcTime = Date.now();
          const raw = typeof data === "string" ? data : Buffer.from(data).toString("utf-8");

          // Handle the first newline-delimited request, respond, then close
          const lines = raw.split("\n").filter((l) => l.trim());
          const firstLine = lines[0];
          if (!firstLine) return;

          // Process only the first request per connection (client expects one response then EOF)
          self
            .handleRequest(firstLine)
            .then((resp) => {
              socket.write(JSON.stringify(resp));
              socket.end();
            })
            .catch((err) => {
              const errResp: DaemonResponse = {
                ok: false,
                error: String(err),
              };
              socket.write(JSON.stringify(errResp));
              socket.end();
            });
        },
        open() {},
        close() {},
        error(_socket, err) {
          process.stderr.write(`[whatsapp-daemon] socket error: ${err}\n`);
        },
      },
    });
  }

  private async handleRequest(raw: string): Promise<DaemonResponse> {
    let req: DaemonRequest;
    try {
      req = JSON.parse(raw);
    } catch {
      return { ok: false, error: "invalid JSON" };
    }

    switch (req.type) {
      case "ping":
        return { ok: true };

      case "status":
        return {
          ok: true,
          data: {
            connected: this.connected,
            pid: process.pid,
            groups: this.groupCache.size,
            queuedMessages: this.outgoingQueue.length,
            uptime: process.uptime(),
          },
        };

      case "send": {
        if (!req.jid || !req.text) {
          return { ok: false, error: "jid and text required" };
        }
        if (!this.connected) {
          this.outgoingQueue.push({ jid: req.jid, text: req.text });
          return {
            ok: true,
            data: { queued: true, queueSize: this.outgoingQueue.length },
          };
        }
        try {
          await this.sock.sendMessage(req.jid, { text: req.text });
          return { ok: true };
        } catch (err) {
          this.outgoingQueue.push({ jid: req.jid, text: req.text });
          return { ok: false, error: `send failed, queued: ${err}` };
        }
      }

      case "resolve-group": {
        if (!req.name) {
          return { ok: false, error: "name required" };
        }
        const needle = req.name.toLowerCase();
        const matches: Array<{ id: string; subject: string }> = [];
        for (const group of this.groupCache.values()) {
          if (group.subject.toLowerCase().includes(needle)) {
            matches.push(group);
          }
        }
        if (matches.length === 0) {
          return {
            ok: false,
            error: `no group matching "${req.name}"`,
          };
        }
        if (matches.length > 1) {
          return {
            ok: false,
            error: `ambiguous: ${matches.length} groups match "${req.name}": ${matches.map((g) => `${g.subject} (${g.id})`).join(", ")}`,
          };
        }
        return { ok: true, data: matches[0] };
      }

      default:
        return { ok: false, error: `unknown request type: ${(req as { type: string }).type}` };
    }
  }

  // -----------------------------------------------------------------------
  // Idle timeout
  // -----------------------------------------------------------------------

  private startIdleCheck(): void {
    this.idleCheckTimer = setInterval(() => {
      const idleMs = Date.now() - this.lastIpcTime;
      const timeoutMs = this.idleTimeoutMin * 60 * 1000;
      if (idleMs >= timeoutMs) {
        process.stderr.write(
          `[whatsapp-daemon] idle for ${this.idleTimeoutMin}min, shutting down\n`,
        );
        this.cleanup();
      }
    }, 60_000);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  private cleanup(): void {
    // Close Baileys connection
    try {
      this.sock?.end(undefined);
    } catch {
      // ignore
    }

    // Close Unix socket server
    try {
      this.unixServer?.stop();
    } catch {
      // ignore
    }

    // Clear idle timer
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }

    // Delete PID file
    try {
      if (existsSync(PID_PATH)) unlinkSync(PID_PATH);
    } catch {
      // ignore
    }

    // Delete socket file
    try {
      if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH);
    } catch {
      // ignore
    }

    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const daemon = new WhatsAppDaemon();
daemon.start().catch((err) => {
  process.stderr.write(`[whatsapp-daemon] fatal: ${err}\n`);
  process.exit(1);
});
