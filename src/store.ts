import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";
import { getConfigDir } from "./config.ts";
import type { MessageEnvelope, MessageFull } from "./types.ts";

// ---------------------------------------------------------------------------
// Database singleton
// ---------------------------------------------------------------------------

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;

  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });

  db = new Database(join(dir, "messages.db"));
  db.run("PRAGMA journal_mode=WAL");

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT NOT NULL,
      provider        TEXT NOT NULL,
      direction       TEXT NOT NULL DEFAULT 'in',
      account         TEXT NOT NULL DEFAULT '',
      from_json       TEXT,
      to_json         TEXT NOT NULL DEFAULT '[]',
      subject         TEXT,
      preview         TEXT NOT NULL DEFAULT '',
      body            TEXT,
      body_format     TEXT DEFAULT 'text',
      date            TEXT NOT NULL,
      unread          INTEGER NOT NULL DEFAULT 1,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      attachments_json TEXT DEFAULT '[]',
      cached_at       TEXT NOT NULL,
      PRIMARY KEY (provider, id)
    )
  `);
  // Non-destructive migration for existing databases
  try { db.run("ALTER TABLE messages ADD COLUMN account TEXT NOT NULL DEFAULT ''"); } catch { /* already exists */ }

  db.run(`
    CREATE TABLE IF NOT EXISTS fetch_log (
      provider   TEXT NOT NULL,
      account    TEXT NOT NULL DEFAULT '',
      folder     TEXT NOT NULL DEFAULT '',
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (provider, account, folder)
    )
  `);

  db.run("CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_provider_date ON messages(provider, date DESC)");

  // thread_id column for SMS conversation threading (nullable for non-SMS providers)
  try {
    db.run("ALTER TABLE messages ADD COLUMN thread_id TEXT");
  } catch {
    // Column already exists — ignore
  }
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(provider, thread_id, date ASC)");


  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      provider    TEXT NOT NULL,
      address     TEXT NOT NULL,
      name        TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (provider, address)
    )
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function upsertMessages(msgs: MessageEnvelope[], direction: "in" | "out" = "in"): void {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO messages
      (id, provider, direction, account, from_json, to_json, subject, preview, date, unread, has_attachments, cached_at)
    VALUES
      ($id, $provider, $direction, $account, $from_json, $to_json, $subject, $preview, $date, $unread, $has_attachments, $cached_at)
    ON CONFLICT(provider, id) DO UPDATE SET
      direction       = excluded.direction,
      account         = CASE WHEN excluded.account != '' THEN excluded.account ELSE messages.account END,
      to_json         = excluded.to_json,
      subject         = excluded.subject,
      preview         = excluded.preview,
      date            = excluded.date,
      unread          = excluded.unread,
      has_attachments = excluded.has_attachments,
      cached_at       = excluded.cached_at,
      from_json       = CASE
        WHEN json_extract(excluded.from_json, '$.name') IS NOT NULL
          AND json_extract(excluded.from_json, '$.name') != ''
          AND json_extract(excluded.from_json, '$.name') != json_extract(excluded.from_json, '$.address')
        THEN excluded.from_json
        WHEN json_extract(messages.from_json, '$.name') IS NOT NULL
          AND json_extract(messages.from_json, '$.name') != ''
          AND json_extract(messages.from_json, '$.name') != json_extract(messages.from_json, '$.address')
        THEN messages.from_json
        ELSE excluded.from_json
      END
  `);

  const now = new Date().toISOString();
  const tx = d.transaction(() => {
    for (const m of msgs) {
      stmt.run({
        $id: m.id,
        $provider: m.provider,
        $direction: direction,
        $account: m.account ?? "",
        $from_json: m.from ? JSON.stringify(m.from) : null,
        $to_json: JSON.stringify(m.to),
        $subject: m.subject ?? null,
        $preview: m.preview,
        $date: m.date,
        $unread: m.unread ? 1 : 0,
        $has_attachments: m.hasAttachments ? 1 : 0,
        $cached_at: now,
      });
    }
  });
  tx();
}

export function upsertFullMessages(
  msgs: MessageFull[],
  direction: "in" | "out" = "in",
  threadId?: string,
): void {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO messages
      (id, provider, direction, account, from_json, to_json, subject, preview, body, body_format, date, unread, has_attachments, attachments_json, cached_at, thread_id)
    VALUES
      ($id, $provider, $direction, $account, $from_json, $to_json, $subject, $preview, $body, $body_format, $date, $unread, $has_attachments, $attachments_json, $cached_at, $thread_id)
    ON CONFLICT(provider, id) DO UPDATE SET
      direction        = excluded.direction,
      account          = CASE WHEN excluded.account != '' THEN excluded.account ELSE messages.account END,
      to_json          = excluded.to_json,
      subject          = excluded.subject,
      preview          = excluded.preview,
      body             = COALESCE(excluded.body, messages.body),
      body_format      = excluded.body_format,
      date             = excluded.date,
      unread           = excluded.unread,
      has_attachments  = excluded.has_attachments,
      attachments_json = excluded.attachments_json,
      cached_at        = excluded.cached_at,
      thread_id        = COALESCE(excluded.thread_id, messages.thread_id),
      from_json        = CASE
        WHEN json_extract(excluded.from_json, '$.name') IS NOT NULL
          AND json_extract(excluded.from_json, '$.name') != ''
          AND json_extract(excluded.from_json, '$.name') != json_extract(excluded.from_json, '$.address')
        THEN excluded.from_json
        WHEN json_extract(messages.from_json, '$.name') IS NOT NULL
          AND json_extract(messages.from_json, '$.name') != ''
          AND json_extract(messages.from_json, '$.name') != json_extract(messages.from_json, '$.address')
        THEN messages.from_json
        ELSE excluded.from_json
      END
  `);

  const now = new Date().toISOString();
  const tx = d.transaction(() => {
    for (const msg of msgs) {
      stmt.run({
        $id: msg.id,
        $provider: msg.provider,
        $direction: direction,
        $account: msg.account ?? "",
        $from_json: msg.from ? JSON.stringify(msg.from) : null,
        $to_json: JSON.stringify(msg.to),
        $subject: msg.subject ?? null,
        $preview: msg.preview,
        $body: msg.body,
        $body_format: msg.bodyFormat,
        $date: msg.date,
        $unread: msg.unread ? 1 : 0,
        $has_attachments: msg.hasAttachments ? 1 : 0,
        $attachments_json: JSON.stringify(msg.attachments.map(({ data, ...rest }) => rest)),
        $cached_at: now,
        $thread_id: threadId ?? null,
      });
    }
  });
  tx();
}

export function upsertFullMessage(msg: MessageFull, direction: "in" | "out" = "in"): void {
  upsertFullMessages([msg], direction);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function rowToEnvelope(row: any): MessageEnvelope {
  return {
    id: row.id,
    provider: row.provider,
    account: row.account || undefined,
    from: row.from_json ? JSON.parse(row.from_json) : null,
    to: JSON.parse(row.to_json),
    subject: row.subject ?? undefined,
    preview: row.preview,
    date: row.date,
    unread: row.unread === 1,
    hasAttachments: row.has_attachments === 1,
  };
}

function rowToFull(row: any): MessageFull {
  return {
    ...rowToEnvelope(row),
    body: row.body ?? "",
    bodyFormat: (row.body_format as "text" | "html") ?? "text",
    attachments: row.attachments_json ? JSON.parse(row.attachments_json) : [],
  };
}

export function getCachedInbox(
  provider: string,
  opts?: { limit?: number; unread?: boolean; since?: string; from?: string },
): MessageEnvelope[] {
  const d = getDb();
  const conditions = ["provider = ?"];
  const params: any[] = [provider];

  // Exclude thread sub-messages from inbox listing — those are individual
  // messages within a conversation, stored via upsertFullMessages() with a threadId
  conditions.push("thread_id IS NULL");

  if (opts?.unread) {
    conditions.push("unread = 1");
  }
  if (opts?.since) {
    conditions.push("date >= ?");
    params.push(opts.since);
  }
  if (opts?.from) {
    conditions.push("(json_extract(from_json, '$.address') LIKE ? OR json_extract(from_json, '$.name') LIKE ?)");
    params.push(`%${opts.from}%`, `%${opts.from}%`);
  }

  const limit = opts?.limit ?? 10;
  const sql = `SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY date DESC LIMIT ?`;
  params.push(limit);

  return d.prepare(sql).all(...params).map(rowToEnvelope);
}

export function getCachedMessage(provider: string, messageId: string): MessageFull | null {
  const d = getDb();
  const row = d.prepare("SELECT * FROM messages WHERE provider = ? AND id = ?").get(provider, messageId);
  if (!row) return null;
  return rowToFull(row);
}

/**
 * Find the recipient address used in a previous outgoing message with the same
 * (normalised) subject. "Outgoing" is detected by checking whether `from_json`
 * contains one of the caller's own account addresses (since IMAP fetches all
 * messages as direction='in', even sent ones visible in All Mail / Sent).
 */
export function getPreviousOutboundRecipient(
  provider: string,
  subject: string,
  ownAccounts: string[],
): string | null {
  if (ownAccounts.length === 0) return null;
  const d = getDb();
  // Strip leading Re:/RE: chains to match across turns
  const normalised = subject.replace(/^(Re:\s*)+/i, "").trim();
  const rows = d
    .prepare(
      `SELECT from_json, to_json FROM messages
       WHERE provider = ? AND subject LIKE ?
       ORDER BY date DESC LIMIT 50`
    )
    .all(provider, `%${normalised}%`) as Array<{ from_json: string; to_json: string }>;

  // Strip +suffix tags (e.g. mo0nkin+services@proton.me → mo0nkin@proton.me)
  const stripTag = (addr: string) => addr.replace(/\+[^@]*@/, "@").toLowerCase();
  const ownNormalised = ownAccounts.map(stripTag);

  for (const row of rows) {
    try {
      const from = JSON.parse(row.from_json) as { address?: string };
      if (ownNormalised.includes(stripTag(from.address ?? ""))) {
        const to = JSON.parse(row.to_json) as Array<{ address?: string }>;
        const addr = to[0]?.address;
        if (addr) return addr;
      }
    } catch {
      // skip malformed rows
    }
  }
  return null;
}

export function getThreadMessages(
  provider: string,
  threadId: string,
  opts?: { limit?: number },
): MessageFull[] {
  const d = getDb();
  const limit = opts?.limit ?? 100;
  const rows = d
    .prepare(
      "SELECT * FROM messages WHERE provider = ? AND thread_id = ? ORDER BY date ASC LIMIT ?"
    )
    .all(provider, threadId, limit);
  return rows.map(rowToFull);
}

export function searchCached(
  query: string,
  provider?: string,
  opts?: { limit?: number; since?: string },
): MessageEnvelope[] {
  const d = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (provider) {
    conditions.push("provider = ?");
    params.push(provider);
  }
  if (opts?.since) {
    conditions.push("date >= ?");
    params.push(opts.since);
  }

  const pattern = `%${query}%`;
  conditions.push("(subject LIKE ? OR preview LIKE ? OR body LIKE ?)");
  params.push(pattern, pattern, pattern);

  const limit = opts?.limit ?? 10;
  const sql = `SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY date DESC LIMIT ?`;
  params.push(limit);

  return d.prepare(sql).all(...params).map(rowToEnvelope);
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export function isFresh(provider: string, maxAgeMs: number, account = "", folder = ""): boolean {
  const d = getDb();
  const row: any = d.prepare(
    "SELECT fetched_at FROM fetch_log WHERE provider = ? AND account = ? AND folder = ?"
  ).get(provider, account, folder);

  if (!row) return false;
  const fetchedAt = new Date(row.fetched_at).getTime();
  return Date.now() - fetchedAt < maxAgeMs;
}

export function recordFetch(provider: string, account = "", folder = ""): void {
  const d = getDb();
  d.prepare(`
    INSERT OR REPLACE INTO fetch_log (provider, account, folder, fetched_at)
    VALUES (?, ?, ?, ?)
  `).run(provider, account, folder, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export function upsertContacts(
  provider: string,
  contacts: Array<{ address: string; name: string }>,
): void {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR REPLACE INTO contacts (provider, address, name, updated_at)
    VALUES ($provider, $address, $name, $updated_at)
  `);
  const now = new Date().toISOString();
  const tx = d.transaction(() => {
    for (const c of contacts) {
      stmt.run({
        $provider: provider,
        $address: c.address,
        $name: c.name,
        $updated_at: now,
      });
    }
  });
  tx();
}

export function backfillMessageNames(provider: string): number {
  const d = getDb();
  const stmt = d.prepare(`
    UPDATE messages
    SET from_json = json_set(from_json, '$.name', (
      SELECT c.name FROM contacts c
      WHERE c.provider = messages.provider
        AND c.address = json_extract(messages.from_json, '$.address')
    ))
    WHERE provider = $provider
      AND from_json IS NOT NULL
      AND (
        json_extract(from_json, '$.name') IS NULL
        OR json_extract(from_json, '$.name') = json_extract(from_json, '$.address')
      )
      AND json_extract(from_json, '$.address') IN (
        SELECT c.address FROM contacts c WHERE c.provider = $provider
      )
  `);
  const result = stmt.run({ $provider: provider });
  return result.changes;
}

export function getContacts(
  provider: string,
  opts?: { limit?: number; search?: string },
): Array<{ address: string; name: string; messageCount: number; lastSeen: string }> {
  const d = getDb();
  const conditions = ["c.provider = ?"];
  const params: any[] = [provider];

  if (opts?.search) {
    conditions.push("c.name LIKE ?");
    params.push(`%${opts.search}%`);
  }

  const limit = opts?.limit ?? 50;

  // Add provider param for the subquery, then limit at the end
  const sql = `
    SELECT
      c.address,
      c.name,
      COALESCE(m.cnt, 0) as messageCount,
      COALESCE(m.last_seen, c.updated_at) as lastSeen
    FROM contacts c
    LEFT JOIN (
      SELECT
        json_extract(from_json, '$.address') as address,
        COUNT(*) as cnt,
        MAX(date) as last_seen
      FROM messages
      WHERE provider = ? AND direction = 'in'
      GROUP BY address
    ) m ON m.address = c.address
    WHERE ${conditions.join(" AND ")}
    ORDER BY m.cnt DESC NULLS LAST, c.name ASC
    LIMIT ?
  `;

  return d.prepare(sql).all(provider, ...params, limit) as any[];
}
