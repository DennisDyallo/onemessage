import { registerProvider } from "../registry.ts";
import * as store from "../store.ts";
import { readFromCacheOrFail, cacheSentMessage } from "./shared.ts";
import type { MessagingProvider } from "../types.ts";
import { existsSync } from "fs";
import { join } from "path";
import { AUTH_DIR } from "../whatsapp-shared.ts";
import { isDaemonRunning, ensureDaemon, daemonRequest } from "../daemon-shared.ts";

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
        store.recordFetch("whatsapp");
      } catch (err) {
        console.warn(`[whatsapp] daemon failed to start: ${err instanceof Error ? err.message : err}`);
      }
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
