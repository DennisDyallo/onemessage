import { existsSync, mkdirSync } from "fs";

import {
  DisconnectReason,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";

import * as store from "./store.ts";
import type { MessageFull } from "./types.ts";
import { AUTH_DIR, createBaileysSocket, parseAndStoreWAMessage } from "./whatsapp-shared.ts";
import { loadConfig } from "./config.ts";
import type { IpcCapableAdapter, DaemonOrchestrator, DaemonResponse } from "./daemon-adapter.ts";

export class WhatsAppAdapter implements IpcCapableAdapter {
  readonly name = "whatsapp";
  readonly polling = false;

  private sock: WASocket | null = null;
  private connected = false;
  private reconnecting = false;
  private groupsSynced = false;
  private lidToPhoneMap = new Map<string, string>();
  private groupCache = new Map<
    string,
    {
      id: string;
      subject: string;
      isCommunity?: boolean;
      linkedParent?: string;
    }
  >();
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;

  async start(_orchestrator: DaemonOrchestrator): Promise<void> {
    const config = loadConfig();
    if (config.daemon?.providers?.whatsapp?.enabled === false) {
      process.stderr.write("[daemon] WhatsApp disabled in config — skipping\n");
      return;
    }

    if (existsSync(AUTH_DIR)) {
      await this.connectWhatsApp();
    } else {
      process.stderr.write(
        "[daemon] WhatsApp auth not found — skipping WhatsApp connection\n",
      );
    }
  }

  async fetch(): Promise<void> {
    // WhatsApp is real-time, not polling — nothing to fetch
  }

  isActive(): boolean {
    return this.connected || this.sock !== null;
  }

  statusInfo(): Record<string, unknown> {
    return {
      connected: this.connected,
      groups: this.groupCache.size,
      queuedMessages: this.outgoingQueue.length,
    };
  }

  cleanup(): void {
    try {
      this.sock?.end(undefined);
    } catch {
      // ignore
    }
  }

  ipcTypes(): string[] {
    return ["send", "resolve-group", "list-groups"];
  }

  async handleIpc(req: Record<string, unknown>): Promise<DaemonResponse | undefined> {
    switch (req.type) {
      case "send":
        return this.handleSend(req as { type: "send"; jid?: string; text?: string });
      case "resolve-group":
        return this.handleResolveGroup(req as { type: "resolve-group"; name?: string });
      case "list-groups":
        return this.handleListGroups();
      default:
        return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // IPC handlers
  // -------------------------------------------------------------------------

  private async handleSend(req: { jid?: string; text?: string }): Promise<DaemonResponse> {
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
      await this.sock!.sendMessage(req.jid, { text: req.text });
      return { ok: true };
    } catch (err) {
      this.outgoingQueue.push({ jid: req.jid, text: req.text });
      return { ok: false, error: `send failed, queued: ${err}` };
    }
  }

  private handleListGroups(): DaemonResponse {
    const groups = Array.from(this.groupCache.values()).sort((a, b) =>
      a.subject.localeCompare(b.subject),
    );
    return { ok: true, data: groups };
  }

  private handleResolveGroup(req: { name?: string }): DaemonResponse {
    if (!req.name) {
      return { ok: false, error: "name required" };
    }

    const slashIdx = req.name.indexOf("/");
    const communityName = (
      slashIdx >= 0 ? req.name.slice(0, slashIdx) : req.name
    )
      .trim()
      .toLowerCase();
    const channelName =
      slashIdx >= 0
        ? req.name.slice(slashIdx + 1).trim().toLowerCase()
        : undefined;

    if (channelName) {
      const communityMatches = Array.from(this.groupCache.values()).filter(
        (g) =>
          g.isCommunity &&
          g.subject.toLowerCase().includes(communityName),
      );
      if (communityMatches.length === 0) {
        return {
          ok: false,
          error: `no community matching "${req.name.slice(0, slashIdx)}"`,
        };
      }
      const parent =
        communityMatches.find(
          (c) => c.subject.toLowerCase() === communityName,
        ) ?? communityMatches[0]!;
      const channels = Array.from(this.groupCache.values()).filter(
        (g) =>
          g.linkedParent === parent.id &&
          g.subject.toLowerCase().includes(channelName),
      );
      if (channels.length === 0) {
        const allChannels = Array.from(this.groupCache.values())
          .filter((g) => g.linkedParent === parent.id)
          .map((g) => g.subject);
        return {
          ok: false,
          error: `no channel "${req.name.slice(slashIdx + 1).trim()}" in ${parent.subject}. Available: ${allChannels.join(", ")}`,
        };
      }
      if (channels.length > 1) {
        return {
          ok: false,
          error: `ambiguous: ${channels.map((c) => `${c.subject} (${c.id})`).join(", ")}`,
        };
      }
      return { ok: true, data: channels[0] };
    }

    const needle = communityName;
    const matches = Array.from(this.groupCache.values()).filter((g) =>
      g.subject.toLowerCase().includes(needle),
    );

    if (matches.length === 0) {
      return { ok: false, error: `no group matching "${req.name}"` };
    }

    if (matches.length === 1) {
      return { ok: true, data: matches[0] };
    }

    const communityHits = matches.filter((g) => g.isCommunity);

    if (communityHits.length === 1) {
      const cParent = communityHits[0]!;
      const children = matches.filter(
        (g) => g.linkedParent === cParent.id,
      );
      const defaultChannel = children.find(
        (c) => c.subject.toLowerCase() === cParent.subject.toLowerCase(),
      );
      if (defaultChannel) {
        return { ok: true, data: defaultChannel };
      }
      const allChannels = Array.from(this.groupCache.values()).filter(
        (g) => g.linkedParent === cParent.id,
      );
      return {
        ok: false,
        error: `"${req.name}" is a community. Use "group:${cParent.subject}/<channel>". Channels: ${allChannels.map((c) => c.subject).join(", ")}`,
      };
    }

    const labels = matches.map((g) => {
      if (g.isCommunity) return `${g.subject} [community] (${g.id})`;
      if (g.linkedParent) {
        const parent = this.groupCache.get(g.linkedParent);
        return `${g.subject} [in ${parent?.subject ?? "unknown"}] (${g.id})`;
      }
      return `${g.subject} (${g.id})`;
    });
    return {
      ok: false,
      error: `ambiguous: ${labels.join(", ")}`,
    };
  }

  // -------------------------------------------------------------------------
  // WhatsApp connection
  // -------------------------------------------------------------------------

  private async connectWhatsApp(): Promise<void> {
    mkdirSync(AUTH_DIR, { recursive: true });

    const { sock, saveCreds } = await createBaileysSocket(AUTH_DIR);
    this.sock = sock;

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        process.stderr.write(
          "[daemon] WhatsApp QR received — auth required before starting daemon. Exiting.\n",
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
            "[daemon] WhatsApp logged out (401). Disabling WhatsApp.\n",
          );
          return;
        }

        if (this.reconnecting) return;
        this.reconnecting = true;
        process.stderr.write(
          `[daemon] WhatsApp connection closed (reason=${reason}), reconnecting in 5s...\n`,
        );
        setTimeout(() => {
          this.reconnecting = false;
          this.connectWhatsApp().catch((err) => {
            process.stderr.write(
              `[daemon] WhatsApp reconnect failed: ${err}\n`,
            );
          });
        }, 5000);
      } else if (connection === "open") {
        this.connected = true;
        process.stderr.write("[daemon] WhatsApp connected\n");

        if (this.sock?.user) {
          const phoneUser = this.sock.user.id.split(":")[0];
          const lidUser = this.sock.user.lid?.split(":")[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap.set(lidUser, `${phoneUser}@s.whatsapp.net`);
          }
        }

        this.flushOutgoingQueue().catch(() => {});

        if (!this.groupsSynced) {
          this.groupsSynced = true;
          this.syncGroupMetadata().catch(() => {});
        }
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        await this.parseAndStoreMessage(msg);
      }
    });

    this.sock.ev.on(
      "messaging-history.set",
      async ({
        messages,
        contacts: syncContacts,
      }) => {
        let stored = 0;
        for (const msg of messages) {
          const ok = await this.parseAndStoreMessage(msg);
          if (ok) stored++;
        }
        if (messages.length > 0) {
          process.stderr.write(
            `[daemon] history sync: stored ${stored}/${messages.length} messages\n`,
          );
        }

        if (syncContacts && syncContacts.length > 0) {
          const toStore = syncContacts
            .filter((c) => c.name || c.notify)
            .map((c) => ({
              address: (c.id.split("@")[0] || c.id).split(":")[0] || c.id,
              name: c.name || c.notify || "",
            }))
            .filter((c) => c.name);

          if (toStore.length > 0) {
            store.upsertContacts("whatsapp", toStore);
            const backfilled = store.backfillMessageNames("whatsapp");
            process.stderr.write(
              `[daemon] history contacts: stored ${toStore.length} contacts, backfilled ${backfilled} messages\n`,
            );
          }
        }
      },
    );

    this.sock.ev.on("chats.upsert", (chats) => {
      let enriched = 0;
      for (const chat of chats) {
        if (!chat.name || !chat.id) continue;
        if (chat.id === "status@broadcast") continue;

        const ts = chat.conversationTimestamp;
        const timestamp = ts
          ? typeof ts === "number"
            ? ts
            : Number(ts)
          : Math.floor(Date.now() / 1000);

        const oneYearAgo = Math.floor(Date.now() / 1000) - 365 * 24 * 60 * 60;
        if (timestamp < oneYearAgo) continue;

        const address = chat.id.split("@")[0] || chat.id;
        const envelope: MessageFull = {
          id: `chat-meta-${chat.id}`,
          provider: "whatsapp",
          from: { name: chat.name, address },
          to: [{ name: "me", address: "me" }],
          subject: undefined,
          preview: `Chat with ${chat.name}`,
          body: `Chat with ${chat.name}`,
          bodyFormat: "text",
          date: new Date(timestamp * 1000).toISOString(),
          unread: false,
          hasAttachments: false,
          direction: "in",
          attachments: [],
        };

        store.upsertFullMessages([envelope]);
        enriched++;
      }
      if (enriched > 0) {
        process.stderr.write(
          `[daemon] enriched ${enriched} WhatsApp contacts from chat list\n`,
        );
      }
    });

    this.sock.ev.on("contacts.upsert", (contacts) => {
      const toStore = contacts
        .filter((c) => c.name || c.notify)
        .map((c) => ({
          address: (c.id.split("@")[0] || c.id).split(":")[0] || c.id,
          name: c.name || c.notify || "",
        }))
        .filter((c) => c.name);

      if (toStore.length > 0) {
        store.upsertContacts("whatsapp", toStore);
        store.backfillMessageNames("whatsapp");
        process.stderr.write(
          `[daemon] contacts.upsert: updated ${toStore.length} contacts\n`,
        );
      }
    });
  }

  private async parseAndStoreMessage(msg: WAMessage): Promise<boolean> {
    const remoteJid = msg.key.remoteJid;
    const resolvedGroupName = remoteJid?.endsWith("@g.us")
      ? this.groupCache.get(remoteJid)?.subject
      : undefined;
    const contactNames = store.getContactNamesByAddress("whatsapp");
    return parseAndStoreWAMessage(msg, this.sock ?? undefined, this.lidToPhoneMap, resolvedGroupName, contactNames);
  }

  private async syncGroupMetadata(): Promise<void> {
    try {
      const groups = await this.sock!.groupFetchAllParticipating();
      this.groupCache.clear();
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          this.groupCache.set(jid, {
            id: jid,
            subject: metadata.subject,
            isCommunity: (metadata as any).isCommunity || false,
            linkedParent: (metadata as any).linkedParent || undefined,
          });
        }
      }
      process.stderr.write(
        `[daemon] synced ${this.groupCache.size} WhatsApp groups\n`,
      );
    } catch (err) {
      process.stderr.write(`[daemon] WhatsApp group sync failed: ${err}\n`);
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sock!.sendMessage(item.jid, { text: item.text });
      }
    } finally {
      this.flushing = false;
    }
  }
}
