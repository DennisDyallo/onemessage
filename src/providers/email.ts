import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { existsSync, readFileSync } from "fs";
import { basename, extname, resolve } from "path";
import { lookup } from "mime-types";
import { registerProvider } from "../registry.ts";
import { loadConfig, EMAIL_DEFAULTS } from "../config.ts";
import * as store from "../store.ts";
import type {
  MessagingProvider,
  SendOptions,
  SendResult,
  InboxOptions,
  ReadOptions,
  SearchOptions,
  MessageEnvelope,
  MessageFull,
} from "../types.ts";

const FRESHNESS_MS = 5 * 60_000; // 5 minutes

// ---------------------------------------------------------------------------
// Resolved email settings (config + CLI overrides merged)
// ---------------------------------------------------------------------------

interface ResolvedEmail {
  password: string;
  accounts: string[];
  defaultAccount: string;
  senderName: string;
  host: string;
  smtpPort: number;
  imapPort: number;
  security: string;
}

function resolveSettings(cliOverrides?: Record<string, unknown>): ResolvedEmail | null {
  const config = loadConfig();
  const email = config.email;

  const password = (cliOverrides?.password as string) ?? email?.password;
  if (!password) return null;

  const accounts = email?.accounts ?? [];
  const cliFrom = cliOverrides?.from as string | undefined;

  const effectiveAccounts = accounts.length > 0 ? accounts : (cliFrom ? [cliFrom] : []);
  if (effectiveAccounts.length === 0) return null;

  const defaultAccount = cliFrom ?? email?.default ?? effectiveAccounts[0]!;

  return {
    password,
    accounts: effectiveAccounts,
    defaultAccount,
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

function hasAttachmentParts(structure: any): boolean {
  if (!structure) return false;
  if (structure.disposition === "attachment") return true;
  if (structure.childNodes) {
    return structure.childNodes.some((child: any) => hasAttachmentParts(child));
  }
  return false;
}

function toEnvelope(uid: number, env: any, flags: Set<string>, bodyStructure: any): MessageEnvelope {
  return {
    id: String(uid),
    provider: "email",
    from: env.from?.[0]
      ? { name: env.from[0].name || "", address: env.from[0].address || "" }
      : null,
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
        messages.push(toEnvelope(msg.uid, msg.envelope, msg.flags ?? new Set(), msg.bodyStructure));
      }
      return messages;
    } finally {
      lock.release();
    }
  } catch (err: any) {
    log(`Error for ${account}: ${err.message}`);
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
      const raw = await client.fetchOne(uid, { source: true, uid: true, envelope: true, flags: true, bodyStructure: true }, { uid: true });
      if (!raw || !raw.source) return null;

      const parsed: ParsedMail = await simpleParser(raw.source);
      const env = raw.envelope;

      let body = "";
      let bodyFormat: "text" | "html" = "text";
      if (prefer === "html" && parsed.html) { body = typeof parsed.html === "string" ? parsed.html : ""; bodyFormat = "html"; }
      else if (parsed.text) { body = parsed.text; }
      else if (parsed.html) { body = typeof parsed.html === "string" ? parsed.html : ""; bodyFormat = "html"; }

      const flags = raw.flags ?? new Set<string>();
      return {
        id: String(raw.uid), provider: "email",
        from: env?.from?.[0] ? { name: env.from[0].name || "", address: env.from[0].address || "" } : null,
        to: (env?.to || []).map((a: any) => ({ name: a.name || "", address: a.address || "" })),
        subject: env?.subject || "", preview: env?.subject || "",
        date: env?.date?.toISOString() || "", unread: !flags.has("\\Seen"),
        hasAttachments: (parsed.attachments || []).length > 0, body, bodyFormat,
        attachments: (parsed.attachments || []).map((att) => ({
          filename: att.filename || "unnamed", contentType: att.contentType || "application/octet-stream",
          size: att.size || 0, ...(includeAttachments ? { data: att.content.toString("base64") } : {}),
        })),
      };
    } finally { lock.release(); }
  } catch (err: any) { log(`Error reading UID ${uid}: ${err.message}`); return null; }
  finally { if (client) await client.logout().catch(() => {}); }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const emailProvider: MessagingProvider = {
  name: "email",
  displayName: "Email (Proton Mail)",

  isConfigured() {
    return resolveSettings() !== null;
  },

  async send(recipientId, body, opts) {
    const s = requireSettings(opts?.providerFlags);
    const from = opts?.account ?? s.defaultAccount;

    if (!s.accounts.includes(from)) {
      return { ok: false, provider: "email", recipientId, error: `"${from}" not in accounts: ${s.accounts.join(", ")}` };
    }

    let finalBody = body;
    let isHtml = opts?.html ?? false;
    if (opts?.file) {
      try { finalBody = readFileSync(opts.file, "utf-8"); }
      catch (err: any) { return { ok: false, provider: "email", recipientId, error: `Cannot read "${opts.file}": ${err.message}` }; }
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
      if (!existsSync(resolved)) { console.error(`Attachment not found: ${resolved}`); process.exit(1); }
      return { filename: basename(resolved), path: resolved, contentType: lookup(extname(resolved)) || "application/octet-stream" };
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
    };

    if (isHtml) { message.html = finalBody; } else { message.text = finalBody; }

    try {
      const info = await transporter.sendMail(message);
      return { ok: true, provider: "email", recipientId, messageId: info.messageId };
    } catch (err: any) {
      return { ok: false, provider: "email", recipientId, error: err.message };
    }
  },

  async inbox(opts) {
    const s = requireSettings(opts?.providerFlags);
    const accounts = pickAccounts(s, opts?.account);
    const folder = opts?.folder ?? "INBOX";
    const limit = opts?.limit ?? 10;

    // Check cache freshness — skip IMAP if recent enough
    const needsFetch = opts?.fresh || !store.isFresh("email", FRESHNESS_MS, accounts.join(","), folder);

    if (needsFetch) {
      const criteria: any = {};
      if (opts?.unread) criteria.seen = false;
      if (opts?.since) {
        const d = new Date(opts.since);
        if (isNaN(d.getTime())) { log(`Invalid --since: ${opts.since}`); return []; }
        criteria.since = d;
      }
      if (opts?.from) criteria.from = opts.from;

      const fetched: MessageEnvelope[] = [];
      for (const account of accounts) {
        fetched.push(...await fetchMailboxMessages(s, account, folder, criteria, limit));
      }

      if (fetched.length > 0) {
        store.upsertMessages(fetched);
      }
      store.recordFetch("email", accounts.join(","), folder);
    }

    return store.getCachedInbox("email", {
      limit,
      unread: opts?.unread,
      since: opts?.since,
      from: opts?.from,
    });
  },

  async read(messageId, opts) {
    const s = requireSettings(opts?.providerFlags);
    const account = opts?.account ?? s.defaultAccount;
    const folder = opts?.folder ?? "INBOX";
    const prefer = opts?.prefer ?? "text";
    const uid = parseInt(messageId, 10);
    if (isNaN(uid) || uid < 1) { console.error(`Invalid message ID: "${messageId}"`); return null; }

    // Check cache first (unless --fresh)
    if (!opts?.fresh) {
      const cached = store.getCachedMessage("email", messageId);
      if (cached && cached.body) return cached;
    }

    // Fetch from IMAP
    const msg = await fetchFullMessage(s, account, folder, uid, prefer, opts?.includeAttachments ?? false);
    if (msg) {
      store.upsertFullMessage(msg);
    }
    return msg;
  },

  async search(query, opts) {
    const s = requireSettings(opts?.providerFlags);
    const accounts = pickAccounts(s, opts?.account);
    const folder = opts?.folder ?? "INBOX";
    const limit = opts?.limit ?? 10;

    // Use freshness gating like inbox — check if recent fetch exists
    const needsFetch = opts?.fresh || !store.isFresh("email", FRESHNESS_MS, accounts.join(","), folder);

    if (!needsFetch) {
      const cached = store.searchCached(query, "email", { limit: opts?.limit, since: opts?.since });
      if (cached.length > 0) return cached;
    }

    const criteria: any = { or: [{ subject: query }, { body: query }] };
    if (opts?.since) {
      const d = new Date(opts.since);
      if (!isNaN(d.getTime())) criteria.since = d;
    }

    const all: MessageEnvelope[] = [];
    for (const account of accounts) {
      all.push(...await fetchMailboxMessages(s, account, folder, criteria, limit));
    }

    if (all.length > 0) {
      store.upsertMessages(all);
    }

    return all.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  },
};

registerProvider(emailProvider);
