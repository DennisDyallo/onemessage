import { existsSync } from "node:fs";
import { join } from "node:path";
import { daemonRequest, ensureDaemon } from "../daemons/shared.ts";
import { registerProvider } from "../registry.ts";
import { validateAttachment } from "../shared/attachment-validation.ts";
import * as store from "../store.ts";
import type { MessagingProvider } from "../types.ts";
import { cacheSentMessage, inboxViaDaemon, readFromCacheOrFail } from "./shared.ts";
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

export const whatsappProvider: MessagingProvider = {
  name: "whatsapp",
  displayName: "WhatsApp (Baileys)",

  isConfigured() {
    return existsSync(join(AUTH_DIR, "creds.json"));
  },

  async authenticate(opts) {
    if (opts?.force) {
      const { rmSync, existsSync } = await import("node:fs");
      if (existsSync(AUTH_DIR)) {
        rmSync(AUTH_DIR, { recursive: true, force: true });
        console.log(`  --force: wiped ${AUTH_DIR}\n`);
      }
    }
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
    return inboxViaDaemon({
      provider: "whatsapp",
      freshnessMs: 60_000,
      fresh: opts?.fresh,
      cacheArgs: {
        limit: opts?.limit,
        unread: opts?.unread,
        since: opts?.since,
        sinceCachedAt: opts?.sinceCachedAt,
        from: opts?.from,
      },
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
      msg.attachments = msg.attachments.map((att) => {
        // Denylist approach: explicitly remove known heavyweight fields,
        // preserve everything else (defensive against future Attachment schema additions)
        const { data: _d, path: _p, unavailable: _u, ...rest } = att;
        return rest;
      });
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
