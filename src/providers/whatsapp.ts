import { existsSync } from "node:fs";
import { join } from "node:path";
import { daemonRequest, ensureDaemon } from "../daemons/shared.ts";
import { registerProvider } from "../registry.ts";
import { validateAttachment } from "../shared/attachment-validation.ts";
import * as store from "../store.ts";
import type { MessagingProvider } from "../types.ts";
import { cacheSentMessage, readFromCacheOrFail } from "./shared.ts";
import { AUTH_DIR } from "./whatsapp-shared.ts";

// ---------------------------------------------------------------------------
// Recipient resolution
// ---------------------------------------------------------------------------

async function recipientToJid(recipientId: string): Promise<string | null> {
  // Phone number: +46... → 46...@s.whatsapp.net
  if (recipientId.startsWith("+")) {
    return `${recipientId.slice(1)}@s.whatsapp.net`;
  }

  // Group: group:name or group:12345678
  if (recipientId.startsWith("group:")) {
    const groupRef = recipientId.slice(6);
    // Purely numeric → direct group JID
    if (/^\d+$/.test(groupRef)) {
      return `${groupRef}@g.us`;
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

  async authenticate(opts) {
    const { runWhatsAppAuth } = await import("./whatsapp-auth.ts");
    await runWhatsAppAuth({ phone: opts?.phone });
  },

  async send(recipientId, body, _opts) {
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
    if (store.isFresh("whatsapp", 60_000) && !opts?.fresh) {
      return store.getCachedInbox("whatsapp", {
        limit: opts?.limit,
        unread: opts?.unread,
        since: opts?.since,
        from: opts?.from,
      });
    }

    try {
      await ensureDaemon();
      store.recordFetch("whatsapp");
    } catch (err) {
      console.warn(
        `[whatsapp] daemon failed to start: ${err instanceof Error ? err.message : err}`,
      );
    }

    return store.getCachedInbox("whatsapp", {
      limit: opts?.limit,
      unread: opts?.unread,
      since: opts?.since,
      from: opts?.from,
    });
  },

  async read(messageId, opts) {
    const msg = readFromCacheOrFail("whatsapp", messageId);
    if (!msg) return null;

    const includeAttachments = opts?.includeAttachments ?? false;

    // For WhatsApp, attachments are eagerly downloaded at parse time,
    // so they already have paths/unavailable populated in the cache.
    //
    // When attachments are NOT requested (inbox-light mode), we need to
    // strip the path/unavailable fields to maintain the three-state invariant.
    if (msg.attachments.length > 0 && !includeAttachments) {
      msg.attachments = msg.attachments.map((att) => ({
        filename: att.filename,
        contentType: att.contentType,
        size: att.size,
        // Explicitly omit data, path, and unavailable for inbox-light mode
      }));
    }

    // Validate that attachments now match the requested state
    if (msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        validateAttachment(att, { attachmentsRequested: includeAttachments });
      }
    }

    return msg;
  },

  async search(query, opts) {
    return store.searchCached(query, "whatsapp", {
      limit: opts?.limit,
      since: opts?.since,
    });
  },
};

registerProvider(whatsappProvider);
