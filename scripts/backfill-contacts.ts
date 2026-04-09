#!/usr/bin/env bun
/**
 * backfill-contacts.ts
 *
 * Extracts contact names from pushName data already stored in the messages
 * table and populates the contacts table. Useful after a fresh re-auth or
 * history sync overwrites live message names.
 *
 * Usage: bun scripts/backfill-contacts.ts [provider]
 * Default provider: whatsapp
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";

const provider = process.argv[2] ?? "whatsapp";
const dbPath = join(homedir(), ".config/onemessage/messages.db");
const db = new Database(dbPath);

// Extract all messages where name differs from address (real pushName)
const rows = db.prepare(`
  SELECT
    json_extract(from_json, '$.address') as address,
    json_extract(from_json, '$.name')    as name,
    COUNT(*)                             as n,
    MAX(date)                            as last_seen
  FROM messages
  WHERE provider = ?
    AND from_json IS NOT NULL
    AND json_extract(from_json, '$.name') IS NOT NULL
    AND json_extract(from_json, '$.name') != ''
    AND json_extract(from_json, '$.name') != json_extract(from_json, '$.address')
    AND json_extract(from_json, '$.address') NOT IN ('me', '')
    AND json_extract(from_json, '$.address') IS NOT NULL
  GROUP BY address
  ORDER BY n DESC
`).all(provider) as Array<{ address: string; name: string; n: number; last_seen: string }>;

if (rows.length === 0) {
  console.log(`No named contacts found in ${provider} messages.`);
  process.exit(0);
}

const now = new Date().toISOString();
const stmt = db.prepare(
  "INSERT OR REPLACE INTO contacts (provider, address, name, updated_at) VALUES (?, ?, ?, ?)"
);
const tx = db.transaction(() => {
  for (const r of rows) stmt.run(provider, r.address, r.name, now);
});
tx();

// Also backfill message from_json names where address now has a known contact
const backfilled = db.prepare(`
  UPDATE messages
  SET from_json = json_set(from_json, '$.name', (
    SELECT c.name FROM contacts c
    WHERE c.provider = messages.provider
      AND c.address = json_extract(messages.from_json, '$.address')
  ))
  WHERE provider = ?
    AND from_json IS NOT NULL
    AND (
      json_extract(from_json, '$.name') IS NULL
      OR json_extract(from_json, '$.name') = json_extract(from_json, '$.address')
    )
    AND json_extract(from_json, '$.address') IN (
      SELECT address FROM contacts WHERE provider = ?
    )
`).run(provider, provider);

const total = (db.prepare("SELECT COUNT(*) as n FROM contacts WHERE provider = ?").get(provider) as any).n;

console.log(`Stored ${rows.length} contacts from ${provider} message history.`);
console.log(`Backfilled names in ${backfilled.changes} messages.`);
console.log(`Total contacts in DB: ${total}`);
console.log();
rows.slice(0, 20).forEach(r =>
  console.log(`  ${String(r.n).padStart(4)} msgs  ${r.name.padEnd(30)}  +${r.address}`)
);
if (rows.length > 20) console.log(`  ... and ${rows.length - 20} more`);
