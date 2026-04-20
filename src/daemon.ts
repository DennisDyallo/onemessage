/**
 * Unified onemessage daemon — holds a persistent WhatsApp (Baileys) connection
 * and polls Signal, Email, and SMS on configurable intervals.
 *
 * Usage: bun run src/daemon.ts
 *
 * Runtime paths (under ~/.config/onemessage/):
 *   daemon.pid  — PID file
 *   daemon.sock — Unix domain socket for IPC
 *   whatsapp/auth/ — Baileys multi-file auth state
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";

import {
  DisconnectReason,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";

import { loadConfig } from "./config.ts";
import * as store from "./store.ts";
import type { MessageFull } from "./types.ts";
import { AUTH_DIR, createBaileysSocket, parseAndStoreWAMessage } from "./whatsapp-shared.ts";
import { DAEMON_PID, DAEMON_SOCK } from "./daemon-shared.ts";
import { fetchSignalInboxAsync, processSignalMessages, startSignalDaemon, type SignalDaemonHandle } from "./providers/signal.ts";
import {
  fetchEmailInbox,
  resolveSettings as resolveEmailSettings,
} from "./providers/email.ts";
import { fetchSmsInbox } from "./providers/sms.ts";
import { fetchTelegramBotUpdates } from "./providers/telegram-bot.ts";
import { fetchInstagramInbox } from "./providers/instagram.ts";
import { cliExists } from "./providers/shared.ts";

// ---------------------------------------------------------------------------
// IPC types
// ---------------------------------------------------------------------------

type DaemonRequest =
  | { type: "send"; jid: string; text: string }
  | { type: "status" }
  | { type: "resolve-group"; name: string }
  | { type: "list-groups" }
  | { type: "ping" }
  | { type: "fetch"; provider?: string }
  | { type: "providers" };

type DaemonResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// UnifiedDaemon
// ---------------------------------------------------------------------------

export class UnifiedDaemon {
  // WhatsApp (real-time)
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

  // Signal daemon mode
  private signalDaemon: SignalDaemonHandle | null = null;

  // Polling
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private polling = new Map<string, boolean>();
  private lastPoll = new Map<string, number>();

  // IPC
  private unixServer: ReturnType<typeof Bun.listen> | null = null;

  // Lifecycle
  private startTime = Date.now();

  /** Derive polled provider names from runtime state — never hardcode. */
  private polledProviderNames(): string[] {
    const names = new Set<string>();
    for (const name of this.pollTimers.keys()) names.add(name);
    for (const name of this.lastPoll.keys()) names.add(name);
    if (this.signalDaemon) names.add("signal");
    return [...names];
  }

  // -----------------------------------------------------------------------
  // Start
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    const configDir = DAEMON_PID.replace(/\/[^/]+$/, "");
    mkdirSync(configDir, { recursive: true });

    // Write PID file
    writeFileSync(DAEMON_PID, String(process.pid), "utf-8");

    // Clean up stale socket
    if (existsSync(DAEMON_SOCK)) {
      try {
        unlinkSync(DAEMON_SOCK);
      } catch {
        // ignore
      }
    }

    // Connect to WhatsApp (if auth exists)
    if (existsSync(AUTH_DIR)) {
      await this.connectWhatsApp();
    } else {
      process.stderr.write(
        "[daemon] WhatsApp auth not found — skipping WhatsApp connection\n",
      );
    }

    // Start polling providers
    this.startPolling();

    // Start IPC server
    this.startIpcServer();

    // Graceful shutdown
    process.on("SIGTERM", () => this.cleanup());
    process.on("SIGINT", () => this.cleanup());

    process.stderr.write(
      `[daemon] started pid=${process.pid} sock=${DAEMON_SOCK}\n`,
    );
  }

  // -----------------------------------------------------------------------
  // WhatsApp connection (adapted from whatsapp-daemon.ts)
  // -----------------------------------------------------------------------

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

        // Build self LID-to-phone mapping
        if (this.sock?.user) {
          const phoneUser = this.sock.user.id.split(":")[0];
          const lidUser = this.sock.user.lid?.split(":")[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap.set(lidUser, `${phoneUser}@s.whatsapp.net`);
          }
        }

        // Flush queued messages
        this.flushOutgoingQueue().catch(() => {});

        // Sync group metadata only once per daemon lifetime to avoid rate-limits
        if (!this.groupsSynced) {
          this.groupsSynced = true;
          this.syncGroupMetadata().catch(() => {});
        }
      }
    });

    // ---- Message reception ----
    this.sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        await this.parseAndStoreMessage(msg);
      }
    });

    // ---- History sync (batches of historical messages on connect) ----
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

        // Store contacts from history sync
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

    // ---- Chat list (contact name enrichment) ----
    this.sock.ev.on("chats.upsert", (chats) => {
      let enriched = 0;
      for (const chat of chats) {
        if (!chat.name || !chat.id) continue;
        // Skip status broadcast and groups (groups already handled via groupCache)
        if (chat.id === "status@broadcast") continue;

        const ts = chat.conversationTimestamp;
        const timestamp = ts
          ? typeof ts === "number"
            ? ts
            : Number(ts)
          : Math.floor(Date.now() / 1000);

        // Only enrich chats with recent-ish activity (within last year)
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

    // ---- Contact sync (name resolution) ----

    // contacts.upsert fires with contact info (incrementally and on sync)
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

  // -----------------------------------------------------------------------
  // Message parsing helper (shared by messages.upsert and history sync)
  // -----------------------------------------------------------------------

  private async parseAndStoreMessage(msg: WAMessage): Promise<boolean> {
    const remoteJid = msg.key.remoteJid;
    const resolvedGroupName = remoteJid?.endsWith("@g.us")
      ? this.groupCache.get(remoteJid)?.subject
      : undefined;
    return parseAndStoreWAMessage(msg, this.sock ?? undefined, this.lidToPhoneMap, resolvedGroupName);
  }

  // -----------------------------------------------------------------------
  // Group metadata
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Outgoing queue
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Polling (Signal, Email, SMS)
  // -----------------------------------------------------------------------

  private startPolling(): void {
    const config = loadConfig();
    const defaultInterval = config.daemon?.pollIntervalMs ?? 60_000; // 1 min

    // Signal
    const signalConfig = config.signal;
    if (signalConfig?.phone) {
      const enabled = config.daemon?.providers?.signal?.enabled !== false;
      const signalMode = config.daemon?.providers?.signal?.mode ?? "poll";

      if (enabled) {
        if (signalMode === "daemon") {
          this.signalDaemon = startSignalDaemon({
            account: signalConfig.phone,
            onMessage: (messages) => {
              const { incoming, outgoing } = processSignalMessages(messages, signalConfig.phone);
              store.recordFetch("signal", signalConfig.phone);
              this.lastPoll.set("signal", Date.now());
              process.stderr.write(
                `[daemon] signal daemon: ${incoming} in + ${outgoing} out\n`,
              );
            },
            onError: (error) => {
              process.stderr.write(`[daemon] signal daemon error: ${error}\n`);
            },
          });
          // Do an initial poll to backfill any messages that arrived while daemon was down
          this.pollProvider("signal", () =>
            fetchSignalInboxAsync(signalConfig.phone),
          );
          process.stderr.write("[daemon] signal using real-time daemon mode\n");
        } else {
          const interval =
            config.daemon?.providers?.signal?.pollIntervalMs ?? defaultInterval;
          this.schedulePoll("signal", interval, () =>
            fetchSignalInboxAsync(signalConfig.phone),
          );
        }
      }
    }

    // Email
    const emailSettings = resolveEmailSettings();
    if (emailSettings) {
      const interval =
        config.daemon?.providers?.email?.pollIntervalMs ?? defaultInterval;
      const enabled = config.daemon?.providers?.email?.enabled !== false;
      if (enabled) {
        this.schedulePoll("email", interval, async () => {
          await fetchEmailInbox(
            emailSettings,
            emailSettings.accounts,
            "INBOX",
          );
        });
      }
    }

    // Telegram bot
    const telegramBotConfig = config.telegramBot;
    if (telegramBotConfig?.botToken) {
      const interval =
        config.daemon?.providers?.["telegram-bot"]?.pollIntervalMs ?? defaultInterval;
      const enabled = config.daemon?.providers?.["telegram-bot"]?.enabled !== false;
      if (enabled) {
        this.schedulePoll("telegram-bot", interval, () =>
          fetchTelegramBotUpdates(telegramBotConfig.botToken),
        );
      }
    }

    // SMS
    if (cliExists("kdeconnect-read-sms")) {
      const interval =
        config.daemon?.providers?.sms?.pollIntervalMs ?? defaultInterval;
      const enabled = config.daemon?.providers?.sms?.enabled !== false;
      if (enabled) {
        this.schedulePoll("sms", interval, () => {
          fetchSmsInbox();
        });
      }
    }

    // Instagram
    const instagramConfig = config.instagram;
    if (instagramConfig?.username && cliExists("instagram-cli")) {
      const interval =
        config.daemon?.providers?.instagram?.pollIntervalMs ?? defaultInterval;
      const enabled = config.daemon?.providers?.instagram?.enabled !== false;
      if (enabled) {
        this.schedulePoll("instagram", interval, () =>
          fetchInstagramInbox(instagramConfig.username),
        );
      }
    }
  }

  private schedulePoll(
    name: string,
    intervalMs: number,
    fn: () => void | Promise<void>,
  ): void {
    // Poll immediately, then on interval
    this.pollProvider(name, fn);
    this.pollTimers.set(
      name,
      setInterval(() => this.pollProvider(name, fn), intervalMs),
    );
    process.stderr.write(
      `[daemon] polling ${name} every ${Math.round(intervalMs / 1000)}s\n`,
    );
  }

  private async pollProvider(
    name: string,
    fn: () => void | Promise<void>,
  ): Promise<void> {
    if (this.polling.get(name)) return; // skip if still running
    this.polling.set(name, true);
    try {
      await fn();
      this.lastPoll.set(name, Date.now());
      process.stderr.write(`[daemon] ${name} polled successfully\n`);
    } catch (err) {
      process.stderr.write(`[daemon] ${name} poll failed: ${err}\n`);
    } finally {
      this.polling.set(name, false);
    }
  }

  // -----------------------------------------------------------------------
  // IPC server (Unix domain socket)
  // -----------------------------------------------------------------------

  private startIpcServer(): void {
    const self = this;

    this.unixServer = Bun.listen({
      unix: DAEMON_SOCK,
      socket: {
        data(socket, data) {
          const raw =
            typeof data === "string"
              ? data
              : Buffer.from(data).toString("utf-8");

          // Handle the first newline-delimited request, respond, then close
          const lines = raw.split("\n").filter((l) => l.trim());
          const firstLine = lines[0];
          if (!firstLine) return;

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
          process.stderr.write(`[daemon] socket error: ${err}\n`);
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

      case "status": {
        const pollingStatus: Record<
          string,
          { lastPoll: string | null; enabled: boolean; mode?: string }
        > = {};
        for (const name of this.polledProviderNames()) {
          const lastMs = this.lastPoll.get(name);
          pollingStatus[name] = {
            lastPoll: lastMs ? new Date(lastMs).toISOString() : null,
            enabled: this.pollTimers.has(name) || (name === "signal" && this.signalDaemon !== null),
            ...(name === "signal" && this.signalDaemon ? { mode: "daemon" } : {}),
          };
        }

        return {
          ok: true,
          data: {
            pid: process.pid,
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
            whatsapp: {
              connected: this.connected,
              groups: this.groupCache.size,
              queuedMessages: this.outgoingQueue.length,
            },
            polling: pollingStatus,
          },
        };
      }

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
          await this.sock!.sendMessage(req.jid, { text: req.text });
          return { ok: true };
        } catch (err) {
          this.outgoingQueue.push({ jid: req.jid, text: req.text });
          return { ok: false, error: `send failed, queued: ${err}` };
        }
      }

      case "list-groups": {
        const groups = Array.from(this.groupCache.values()).sort((a, b) =>
          a.subject.localeCompare(b.subject),
        );
        return { ok: true, data: groups };
      }

      case "resolve-group": {
        if (!req.name) {
          return { ok: false, error: "name required" };
        }

        // Support "Community/Channel" syntax for community sub-groups
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
          // Looking for a specific channel within a community
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
          // Find the channel under this community
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

        // Simple name lookup
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

        // Multiple matches — check if they're all from the same community
        const communityHits = matches.filter((g) => g.isCommunity);

        // If exactly one community matches and the rest are its children,
        // resolve to the default channel (child with same name as parent)
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
          // No default channel — list available channels
          const allChannels = Array.from(this.groupCache.values()).filter(
            (g) => g.linkedParent === cParent.id,
          );
          return {
            ok: false,
            error: `"${req.name}" is a community. Use "group:${cParent.subject}/<channel>". Channels: ${allChannels.map((c) => c.subject).join(", ")}`,
          };
        }

        // Truly ambiguous — show context for each match
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

      case "fetch": {
        const provider = req.provider;
        const config = loadConfig();

        if (provider) {
          // Trigger a single provider
          switch (provider) {
            case "signal": {
              const phone = config.signal?.phone;
              if (!phone)
                return { ok: false, error: "signal not configured" };
              await this.pollProvider("signal", () =>
                fetchSignalInboxAsync(phone),
              );
              return { ok: true };
            }
            case "email": {
              const settings = resolveEmailSettings();
              if (!settings)
                return { ok: false, error: "email not configured" };
              await this.pollProvider("email", () =>
                fetchEmailInbox(settings, settings.accounts, "INBOX"),
              );
              return { ok: true };
            }
            case "sms": {
              if (!cliExists("kdeconnect-read-sms"))
                return {
                  ok: false,
                  error: "kdeconnect-read-sms not found",
                };
              await this.pollProvider("sms", () => fetchSmsInbox());
              return { ok: true };
            }
            case "telegram-bot": {
              const token = config.telegramBot?.botToken;
              if (!token)
                return { ok: false, error: "telegram-bot not configured" };
              await this.pollProvider("telegram-bot", () =>
                fetchTelegramBotUpdates(token),
              );
              return { ok: true };
            }
            case "instagram": {
              const username = config.instagram?.username;
              if (!username)
                return { ok: false, error: "instagram not configured" };
              await this.pollProvider("instagram", () =>
                fetchInstagramInbox(username),
              );
              return { ok: true };
            }
            default:
              return {
                ok: false,
                error: `unknown provider: ${provider}`,
              };
          }
        }

        // Poll all configured providers
        const promises: Promise<void>[] = [];
        if (config.signal?.phone) {
          const phone = config.signal.phone;
          promises.push(
            this.pollProvider("signal", () => fetchSignalInboxAsync(phone)),
          );
        }
        const emailSettings = resolveEmailSettings();
        if (emailSettings) {
          promises.push(
            this.pollProvider("email", () =>
              fetchEmailInbox(emailSettings, emailSettings.accounts, "INBOX"),
            ),
          );
        }
        if (cliExists("kdeconnect-read-sms")) {
          promises.push(
            this.pollProvider("sms", () => fetchSmsInbox()),
          );
        }
        if (config.telegramBot?.botToken) {
          const token = config.telegramBot.botToken;
          promises.push(
            this.pollProvider("telegram-bot", () => fetchTelegramBotUpdates(token)),
          );
        }
        if (config.instagram?.username) {
          const username = config.instagram.username;
          promises.push(
            this.pollProvider("instagram", () => fetchInstagramInbox(username)),
          );
        }
        await Promise.allSettled(promises);
        return { ok: true };
      }

      case "providers": {
        const providers: Record<
          string,
          { enabled: boolean; polling: boolean; lastPoll: string | null }
        > = {};

        // WhatsApp
        providers.whatsapp = {
          enabled: this.connected || this.sock !== null,
          polling: false, // real-time, not polled
          lastPoll: null,
        };

        // Polled providers
        for (const name of this.polledProviderNames()) {
          const lastMs = this.lastPoll.get(name);
          providers[name] = {
            enabled: this.pollTimers.has(name) || (name === "signal" && this.signalDaemon !== null),
            polling: this.polling.get(name) ?? false,
            lastPoll: lastMs ? new Date(lastMs).toISOString() : null,
          };
        }

        return { ok: true, data: providers };
      }

      default:
        return {
          ok: false,
          error: `unknown request type: ${(req as { type: string }).type}`,
        };
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  private cleanup(): void {
    // Stop Signal daemon subprocess
    try {
      this.signalDaemon?.stop();
    } catch {
      // ignore
    }

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

    // Clear poll timers
    for (const timer of this.pollTimers.values()) {
      clearInterval(timer);
    }
    this.pollTimers.clear();

    // Delete PID file
    try {
      if (existsSync(DAEMON_PID)) unlinkSync(DAEMON_PID);
    } catch {
      // ignore
    }

    // Delete socket file
    try {
      if (existsSync(DAEMON_SOCK)) unlinkSync(DAEMON_SOCK);
    } catch {
      // ignore
    }

    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const daemon = new UnifiedDaemon();
daemon.start().catch((err) => {
  process.stderr.write(`[daemon] fatal: ${err}\n`);
  process.exit(1);
});
