import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";
import { getConfigDir } from "./config.ts";
import type { MessageEnvelope, MessageFull, Contact } from "./types.ts";

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

  return db;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function upsertMessages(msgs: MessageEnvelope[], direction: "in" | "out" = "in"): void {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR REPLACE INTO messages
      (id, provider, direction, from_json, to_json, subject, preview, date, unread, has_attachments, cached_at)
    VALUES
      ($id, $provider, $direction, $from_json, $to_json, $subject, $preview, $date, $unread, $has_attachments, $cached_at)
  `);

  const now = new Date().toISOString();
  const tx = d.transaction(() => {
    for (const m of msgs) {
      stmt.run({
        $id: m.id,
        $provider: m.provider,
        $direction: direction,
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

export function upsertFullMessage(msg: MessageFull, direction: "in" | "out" = "in"): void {
  const d = getDb();
  const now = new Date().toISOString();
  d.prepare(`
    INSERT OR REPLACE INTO messages
      (id, provider, direction, from_json, to_json, subject, preview, body, body_format, date, unread, has_attachments, attachments_json, cached_at)
    VALUES
      ($id, $provider, $direction, $from_json, $to_json, $subject, $preview, $body, $body_format, $date, $unread, $has_attachments, $attachments_json, $cached_at)
  `).run({
    $id: msg.id,
    $provider: msg.provider,
    $direction: direction,
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
  });
}

export function upsertFullMessages(msgs: MessageFull[], direction: "in" | "out" = "in"): void {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR REPLACE INTO messages
      (id, provider, direction, from_json, to_json, subject, preview, body, body_format, date, unread, has_attachments, attachments_json, cached_at)
    VALUES
      ($id, $provider, $direction, $from_json, $to_json, $subject, $preview, $body, $body_format, $date, $unread, $has_attachments, $attachments_json, $cached_at)
  `);

  const now = new Date().toISOString();
  const tx = d.transaction(() => {
    for (const msg of msgs) {
      stmt.run({
        $id: msg.id,
        $provider: msg.provider,
        $direction: direction,
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
      });
    }
  });
  tx();
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function rowToEnvelope(row: any): MessageEnvelope {
  return {
    id: row.id,
    provider: row.provider,
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

  if (opts?.unread) {
    conditions.push("unread = 1");
  }
  if (opts?.since) {
    conditions.push("date >= ?");
    params.push(opts.since);
  }
  if (opts?.from) {
    conditions.push("json_extract(from_json, '$.address') LIKE ?");
    params.push(`%${opts.from}%`);
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
