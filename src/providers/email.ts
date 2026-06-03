import { existsSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { ImapFlow } from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
import { lookup } from "mime-types";
import nodemailer from "nodemailer";
import { EMAIL_DEFAULTS, loadConfig } from "../config.ts";
import { registerProvider } from "../registry.ts";
import { validateAttachment } from "../shared/attachment-validation.ts";
import * as store from "../store.ts";
import type { Contact, MessageEnvelope, MessageFull, MessagingProvider } from "../types.ts";
import { cacheSentMessage, inboxViaDaemon } from "./shared.ts";

const FRESHNESS_MS = 5 * 60_000; // 5 minutes

// ---------------------------------------------------------------------------
// Direction detection helper
// ---------------------------------------------------------------------------

function isOutgoingEmail(fromAddr: string | undefined, settings: ResolvedEmail): boolean {
  if (!fromAddr) return false;
  const ownAddresses = [...settings.accounts, ...(settings.secondaryAccounts ?? [])];
  const stripTag = (addr: string) => addr.replace(/\+[^@]*@/, "@").toLowerCase();
  const normalizedFrom = stripTag(fromAddr);
  return ownAddresses.some((own) => stripTag(own) === normalizedFrom);
}

function contactsFromAddressObject(addresses: ParsedMail["replyTo"]): Contact[] {
  return (addresses?.value ?? [])
    .map((address) => ({ name: address.name || "", address: address.address || "" }))
    .filter((address) => address.address.length > 0);
}

function referencesFromParsed(references: ParsedMail["references"]): string[] {
  if (!references) return [];
  return Array.isArray(references) ? references : [references];
}

export function emailReplySubject(subject: string | undefined): string | undefined {
  if (!subject) return undefined;
  return /^re:\s/i.test(subject) ? subject : `Re: ${subject}`;
}

export function buildEmailReferences(
  original: Pick<MessageFull, "references" | "rfcMessageId">,
): string[] | undefined {
  const references = [...(original.references ?? [])];
  if (original.rfcMessageId && !references.includes(original.rfcMessageId)) {
    references.push(original.rfcMessageId);
  }
  return references.length > 0 ? references : undefined;
}

export function resolveEmailReplyRecipient(
  original: MessageFull,
  subject: string | undefined,
  ownAccounts: string[],
): string | null {
  if (original.direction === "out") return original.to[0]?.address ?? null;

  const replyToRecipient = original.replyTo?.find((contact) => contact.address)?.address;
  if (replyToRecipient) return replyToRecipient;

  const directRecipient = original.from?.address ?? null;
  const previousAlias = subject
    ? store.getPreviousOutboundRecipient("email", subject, ownAccounts)
    : null;
  return previousAlias ?? directRecipient;
}

// ---------------------------------------------------------------------------
// Resolved email settings (config + CLI overrides merged)
// ---------------------------------------------------------------------------

export interface ResolvedEmail {
  password: string;
  accounts: string[];
  secondaryAccounts: string[];
  defaultAccount: string;
  defaultFolder: string;
  senderName: string;
  host: string;
  smtpPort: number;
  imapPort: number;
  security: string;
}

export function resolveSettings(cliOverrides?: Record<string, unknown>): ResolvedEmail | null {
  const config = loadConfig();
  const email = config.email;

  const password = (cliOverrides?.password as string) ?? email?.password;
  if (!password) return null;

  const primaryAccounts = email?.accounts ?? [];
  const secondaryAccounts = email?.secondaryAccounts ?? [];
  const cliFrom = cliOverrides?.from as string | undefined;

  // secondaryAccounts are implicitly part of the account list — no need to duplicate in config
  const allAccounts = [...new Set([...primaryAccounts, ...secondaryAccounts])];
  const effectiveAccounts = allAccounts.length > 0 ? allAccounts : cliFrom ? [cliFrom] : [];
  if (effectiveAccounts.length === 0) return null;

  const defaultAccount =
    cliFrom ?? email?.default ?? primaryAccounts[0] ?? effectiveAccounts[0] ?? "";

  return {
    password,
    accounts: effectiveAccounts,
    secondaryAccounts,
    defaultAccount,
    defaultFolder: email?.defaultFolder ?? "INBOX",
    senderName: (cliOverrides?.senderName as string) ?? config.senderName ?? "",
    host: (cliOverrides?.host as string) ?? email?.host ?? EMAIL_DEFAULTS.host,
    smtpPort: (cliOverrides?.smtpPort as number) ?? email?.smtpPort ?? EMAIL_DEFAULTS.smtpPort,
    imapPort: (cliOverrides?.imapPort as number) ?? email?.imapPort ?? EMAIL_DEFAULTS.imapPort,
    security: (cliOverrides?.security as string) ?? email?.security ?? EMAIL_DEFAULTS.security,
  };
}

function requireSettings(cliOverrides?: Record<string, unknown>): ResolvedEmail {
  const settings = resolveSettings(cliOverrides);
  if (!settings) {
    console.error("Email not configured. Run: onemessage auth email");
    process.exit(1);
  }
  return settings;
}

// ---------------------------------------------------------------------------
// IMAP helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  process.stderr.write(`[email] ${msg}\n`);
}

async function createImapClient(s: ResolvedEmail, account: string): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: s.host,
    port: s.imapPort,
    secure: false,
    auth: { user: account, pass: s.password },
    tls: { rejectUnauthorized: false },
    logger: false,
  });
  await client.connect();
  return client;
}

function pickAccounts(s: ResolvedEmail, accountFilter?: string): string[] {
  if (!accountFilter) return s.accounts;
  if (!s.accounts.includes(accountFilter)) {
    console.error(`Email account "${accountFilter}" not found.`);
    console.error(`Available: ${s.accounts.join(", ")}`);
    process.exit(1);
  }
  return [accountFilter];
}

export function emailMessageId(account: string, folder: string, uid: number): string {
  return `account:${encodeURIComponent(account)}:folder:${encodeURIComponent(folder)}:uid:${uid}`;
}

export function parseEmailMessageId(messageId: string): {
  account?: string;
  folder?: string;
  uid: number | null;
} {
  const match = /^account:([^:]+):folder:([^:]+):uid:(\d+)$/.exec(messageId);
  if (!match) {
    const legacyUid = parseInt(messageId, 10);
    return { uid: Number.isNaN(legacyUid) ? null : legacyUid };
  }
  return {
    account: decodeURIComponent(match[1] ?? ""),
    folder: decodeURIComponent(match[2] ?? ""),
    uid: parseInt(match[3] ?? "", 10),
  };
}

function cachedEmailHasRequestedAttachments(msg: MessageFull): boolean {
  if (!msg.hasAttachments) return true;
  if (msg.attachments.length === 0) return false;
  return msg.attachments.every((att) => {
    try {
      validateAttachment(att, { attachmentsRequested: true });
      return true;
    } catch {
      return false;
    }
  });
}

// biome-ignore lint/suspicious/noExplicitAny: imapflow body structure is untyped
function hasAttachmentParts(structure: any): boolean {
  if (!structure) return false;
  if (structure.disposition === "attachment") return true;
  if (structure.childNodes) {
    // biome-ignore lint/suspicious/noExplicitAny: imapflow body structure children are untyped
    return structure.childNodes.some((child: any) => hasAttachmentParts(child));
  }
  return false;
}

function toEnvelope(
  uid: number,
  folder: string,
  // biome-ignore lint/suspicious/noExplicitAny: imapflow envelope is untyped
  env: any,
  flags: Set<string>,
  // biome-ignore lint/suspicious/noExplicitAny: imapflow bodyStructure is untyped
  bodyStructure: any,
  account = "",
): MessageEnvelope {
  return {
    id: emailMessageId(account, folder, uid),
    provider: "email",
    account,
    from: env.from?.[0]
      ? { name: env.from[0].name || "", address: env.from[0].address || "" }
      : null,
    // biome-ignore lint/suspicious/noExplicitAny: imapflow address objects are untyped
    to: (env.to || []).map((a: any) => ({ name: a.name || "", address: a.address || "" })),
    subject: env.subject || "",
    preview: env.subject || "",
    date: env.date?.toISOString() || "",
    unread: !flags.has("\\Seen"),
    hasAttachments: hasAttachmentParts(bodyStructure),
  };
}

async function fetchMailboxMessages(
  s: ResolvedEmail,
  account: string,
  folder: string,
  // biome-ignore lint/suspicious/noExplicitAny: imapflow search criteria is untyped
  criteria: any,
  limit: number,
): Promise<MessageEnvelope[]> {
  let client: ImapFlow | null = null;
  try {
    client = await createImapClient(s, account);
    const lock = await client.getMailboxLock(folder);
    try {
      const uids = await client.search(criteria, { uid: true });
      if (!uids || uids.length === 0) return [];

      const messages: MessageEnvelope[] = [];
      for await (const msg of client.fetch(
        uids.slice(-limit),
        { uid: true, envelope: true, flags: true, bodyStructure: true },
        { uid: true },
      )) {
        messages.push(
          toEnvelope(
            msg.uid,
            folder,
            msg.envelope,
            msg.flags ?? new Set(),
            msg.bodyStructure,
            account,
          ),
        );
      }
      return messages;
    } finally {
      lock.release();
    }
  } catch (err: unknown) {
    log(`Error for ${account}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

async function fetchFullMessage(
  s: ResolvedEmail,
  account: string,
  folder: string,
  uid: number,
  prefer: "text" | "html",
  includeAttachments: boolean,
): Promise<MessageFull | null> {
  let client: ImapFlow | null = null;
  try {
    client = await createImapClient(s, account);
    const lock = await client.getMailboxLock(folder);
    try {
      const raw = await client.fetchOne(
        uid,
        { source: true, uid: true, envelope: true, flags: true, bodyStructure: true },
        { uid: true },
      );
      if (!raw || typeof raw === "boolean" || !raw.source) return null;

      const parsed: ParsedMail = await simpleParser(raw.source);
      const env = raw.envelope;

      let body = "";
      let bodyFormat: "text" | "html" = "text";
      if (prefer === "html" && parsed.html) {
        body = typeof parsed.html === "string" ? parsed.html : "";
        bodyFormat = "html";
      } else if (parsed.text) {
        body = parsed.text;
      } else if (parsed.html) {
        body = typeof parsed.html === "string" ? parsed.html : "";
        bodyFormat = "html";
      }

      const flags = raw.flags ?? new Set<string>();
      const fromAddr = env?.from?.[0]?.address;
      const replyTo = contactsFromAddressObject(parsed.replyTo);
      const references = referencesFromParsed(parsed.references);
      return {
        id: emailMessageId(account, folder, raw.uid),
        provider: "email",
        account,
        from: env?.from?.[0]
          ? { name: env.from[0].name || "", address: env.from[0].address || "" }
          : null,
        // biome-ignore lint/suspicious/noExplicitAny: imapflow address objects are untyped
        to: (env?.to || []).map((a: any) => ({ name: a.name || "", address: a.address || "" })),
        subject: env?.subject || "",
        preview: env?.subject || "",
        date: env?.date?.toISOString() || "",
        unread: !flags.has("\\Seen"),
        hasAttachments: (parsed.attachments || []).length > 0,
        body,
        bodyFormat,
        attachments: (parsed.attachments || []).map((att) => {
          const attachment = {
            filename: att.filename || "unnamed",
            contentType: att.contentType || "application/octet-stream",
            size: att.size || 0,
            ...(includeAttachments ? { data: att.content.toString("base64") } : {}),
          };
          validateAttachment(attachment, { attachmentsRequested: includeAttachments });
          return attachment;
        }),
        ...(parsed.messageId ? { rfcMessageId: parsed.messageId } : {}),
        ...(replyTo.length > 0 ? { replyTo } : {}),
        ...(references.length > 0 ? { references } : {}),
        direction: isOutgoingEmail(fromAddr, s) ? "out" : "in",
      };
    } finally {
      lock.release();
    }
  } catch (err: unknown) {
    log(`Error reading UID ${uid}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Fetch-and-cache (callable by daemon)
// ---------------------------------------------------------------------------

export async function fetchEmailInbox(
  s: ResolvedEmail,
  accounts: string[],
  folder: string,
  // biome-ignore lint/suspicious/noExplicitAny: imapflow search criteria is untyped
  criteria?: any,
  limit?: number,
): Promise<void> {
  // Cache all accounts (primary and secondary) — display filtering happens at read time
  const fetched: MessageEnvelope[] = [];
  for (const account of accounts) {
    fetched.push(...(await fetchMailboxMessages(s, account, folder, criteria ?? {}, limit ?? 50)));
  }
  const incoming = fetched.filter((m) => !isOutgoingEmail(m.from?.address, s));
  const outgoing = fetched.filter((m) => isOutgoingEmail(m.from?.address, s));
  if (incoming.length > 0) store.upsertMessages(incoming, "in");
  if (outgoing.length > 0) store.upsertMessages(outgoing, "out");
  console.error(`[email] Stored ${incoming.length} in + ${outgoing.length} out envelopes`);
  store.recordFetch("email", accounts.join(","), folder);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const emailProvider: MessagingProvider = {
  name: "email",
  displayName: "Email (IMAP/SMTP)",

  isConfigured() {
    return resolveSettings() !== null;
  },

  async send(recipientId, body, opts) {
    const s = requireSettings(opts?.providerFlags);
    const from = opts?.account ?? s.defaultAccount;

    if (!s.accounts.includes(from)) {
      return {
        ok: false,
        provider: "email",
        recipientId,
        error: `"${from}" not in accounts: ${s.accounts.join(", ")}`,
      };
    }

    let finalBody = body;
    let isHtml = opts?.html ?? false;
    if (opts?.file) {
      try {
        finalBody = readFileSync(opts.file, "utf-8");
      } catch (err: unknown) {
        return {
          ok: false,
          provider: "email",
          recipientId,
          error: `Cannot read "${opts.file}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (opts.file.endsWith(".html") || opts.file.endsWith(".htm")) isHtml = true;
    }

    const transporter = nodemailer.createTransport({
      host: s.host,
      port: s.smtpPort,
      secure: false,
      requireTLS: s.security === "STARTTLS",
      auth: { user: from, pass: s.password },
      tls: { rejectUnauthorized: false },
    });

    const attachments = (opts?.attachments ?? []).map((filePath) => {
      const resolved = resolve(filePath);
      if (!existsSync(resolved)) {
        console.error(`Attachment not found: ${resolved}`);
        process.exit(1);
      }
      return {
        filename: basename(resolved),
        path: resolved,
        contentType: lookup(extname(resolved)) || "application/octet-stream",
      };
    });

    const fromHeader = s.senderName ? `"${s.senderName}" <${from}>` : from;

    const message: nodemailer.SendMailOptions = {
      from: fromHeader,
      to: recipientId,
      subject: opts?.subject ?? "(no subject)",
      attachments,
      ...(opts?.cc && { cc: opts.cc.join(", ") }),
      ...(opts?.bcc && { bcc: opts.bcc.join(", ") }),
      ...(opts?.replyTo && { replyTo: opts.replyTo }),
      ...(opts?.inReplyTo && { inReplyTo: opts.inReplyTo }),
      ...(opts?.references && { references: opts.references }),
    };

    if (isHtml) {
      message.html = finalBody;
    } else {
      message.text = finalBody;
    }

    try {
      const info = await transporter.sendMail(message);
      cacheSentMessage({
        provider: "email",
        messageId: info.messageId,
        account: from,
        fromAddress: from,
        recipientId,
        body: finalBody,
        bodyFormat: isHtml ? "html" : "text",
        subject: message.subject?.toString(),
        hasAttachments: attachments.length > 0,
        rfcMessageId: info.messageId,
        ...(opts?.replyTo ? { replyTo: [{ name: "", address: opts.replyTo }] } : {}),
        ...(opts?.references ? { references: opts.references } : {}),
      });
      return { ok: true, provider: "email", recipientId, messageId: info.messageId };
    } catch (err: unknown) {
      return {
        ok: false,
        provider: "email",
        recipientId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async reply(messageId, body, opts) {
    const s = requireSettings(opts?.providerFlags);
    let original = store.getCachedMessage("email", messageId);
    const needsMetadataRefresh =
      !original ||
      (original.direction !== "out" &&
        (!original.rfcMessageId || !original.replyTo || !original.references));

    if (needsMetadataRefresh) {
      const fetched = await emailProvider.read(messageId, {
        account: opts?.account,
        fresh: true,
        providerFlags: opts?.providerFlags,
      });
      if (fetched) original = fetched;
    }

    if (!original) {
      return {
        ok: false,
        provider: "email",
        recipientId: "",
        error: `Message "${messageId}" not found in cache or mailbox.`,
      };
    }

    const subject = opts?.subject ?? emailReplySubject(original.subject);
    const recipientId = resolveEmailReplyRecipient(original, subject, s.accounts);
    if (!recipientId) {
      return {
        ok: false,
        provider: "email",
        recipientId: "",
        error: "Cannot reply: original message has no sender or Reply-To address.",
      };
    }

    return emailProvider.send(recipientId, body, {
      ...opts,
      subject,
      inReplyTo: opts?.inReplyTo ?? original.rfcMessageId,
      references: opts?.references ?? buildEmailReferences(original),
    });
  },

  async inbox(opts) {
    const s = requireSettings(opts?.providerFlags);
    const accounts = pickAccounts(s, opts?.account);
    const folder = opts?.folder ?? s.defaultFolder;
    const limit = opts?.limit ?? 10;

    // Build criteria from opts (pre-helper) — needed for both daemon and fallback paths
    // biome-ignore lint/suspicious/noExplicitAny: imapflow search criteria is untyped
    const criteria: any = {};
    if (opts?.unread) criteria.seen = false;
    if (opts?.since) {
      const d = new Date(opts.since);
      if (Number.isNaN(d.getTime())) {
        log(`Invalid --since: ${opts.since}`);
        return [];
      }
      criteria.since = d;
    }
    if (opts?.from) criteria.from = opts.from;

    // Default view: exclude secondary accounts. --all includes everything.
    const excludeAccounts = opts?.all ? [] : s.secondaryAccounts;
    const cacheArgs = {
      limit,
      unread: opts?.unread,
      since: opts?.since,
      sinceCachedAt: opts?.sinceCachedAt,
      from: opts?.from,
      excludeAccounts,
    };

    // Daemon's EmailAdapter.fetch() only refreshes INBOX with no criteria for ALL accounts.
    // For non-default requests (custom folder OR custom criteria OR account filter OR explicit limit), bypass
    // the helper and fetch directly — daemon can't service these without freshness key mismatch.
    const isDefaultRequest =
      folder === "INBOX" && Object.keys(criteria).length === 0 && !opts?.account && !opts?.limit;

    if (!isDefaultRequest) {
      // Custom folder or criteria — daemon can't service this; fetch directly
      const needsFetch =
        opts?.fresh || !store.isFresh("email", FRESHNESS_MS, accounts.join(","), folder);
      if (needsFetch) {
        await fetchEmailInbox(s, accounts, folder, criteria, limit);
      }
      return store.getCachedInbox("email", cacheArgs);
    }

    // Default INBOX request with no custom criteria — route through daemon for contention safety
    return inboxViaDaemon({
      provider: "email",
      freshnessMs: FRESHNESS_MS,
      account: accounts.join(","),
      folder,
      fresh: opts?.fresh,
      cacheArgs,
      fallbackFetch: () => fetchEmailInbox(s, accounts, folder, criteria, limit),
    });
  },

  async read(messageId, opts) {
    const s = requireSettings(opts?.providerFlags);
    const parsedId = parseEmailMessageId(messageId);
    const folder = opts?.folder ?? parsedId.folder ?? s.defaultFolder;
    const prefer = opts?.prefer ?? "text";
    const uid = parsedId.uid;
    if (uid === null || uid < 1) {
      console.error(`Invalid message ID: "${messageId}"`);
      return null;
    }

    // Always look up cache to find which account owns this UID —
    // even with --fresh we need the account for the IMAP fetch.
    const cached = store.getCachedMessage("email", messageId);
    if (!opts?.fresh && cached?.body) {
      if (!opts?.includeAttachments || cachedEmailHasRequestedAttachments(cached)) return cached;
    }

    // Use: explicit --account flag > account stored in cache > default account
    const account = opts?.account ?? parsedId.account ?? cached?.account ?? s.defaultAccount;

    // Fetch from IMAP
    const msg = await fetchFullMessage(
      s,
      account,
      folder,
      uid,
      prefer,
      opts?.includeAttachments ?? false,
    );
    if (msg) {
      store.upsertFullMessage(msg);
    }
    return msg;
  },

  async search(query, opts) {
    const s = requireSettings(opts?.providerFlags);
    const accounts = pickAccounts(s, opts?.account);
    const folder = opts?.folder ?? s.defaultFolder;
    const limit = opts?.limit ?? 10;

    // Use freshness gating like inbox — check if recent fetch exists
    const needsFetch =
      opts?.fresh || !store.isFresh("email", FRESHNESS_MS, accounts.join(","), folder);

    if (!needsFetch) {
      const cached = store.searchCached(query, "email", { limit: opts?.limit, since: opts?.since });
      if (cached.length > 0) return cached;
    }

    // biome-ignore lint/suspicious/noExplicitAny: imapflow search criteria is untyped
    const criteria: any = { or: [{ subject: query }, { body: query }] };
    if (opts?.since) {
      const d = new Date(opts.since);
      if (!Number.isNaN(d.getTime())) criteria.since = d;
    }

    const all: MessageEnvelope[] = [];
    for (const account of accounts) {
      const msgs = await fetchMailboxMessages(s, account, folder, criteria, limit);
      if (msgs.length > 0) {
        const incoming = msgs.filter((m) => !isOutgoingEmail(m.from?.address, s));
        const outgoing = msgs.filter((m) => isOutgoingEmail(m.from?.address, s));
        if (incoming.length > 0) store.upsertMessages(incoming, "in");
        if (outgoing.length > 0) store.upsertMessages(outgoing, "out");
      }
      all.push(...msgs);
    }

    return all.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  },
};

registerProvider(emailProvider);

export { emailProvider };
