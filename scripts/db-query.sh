#!/usr/bin/env bash
# db-query.sh — Backend SQLite queries for the onemessage message cache
# DB: ~/.config/onemessage/messages.db
#
# Usage: ./scripts/db-query.sh <command> [args]
#
# Commands:
#   stats                          — message counts per provider
#   contacts [provider]            — list all known contacts with message counts
#   thread <number> [provider]     — full message thread with a phone number
#   between <number> [provider]    — count + date range of messages with a contact
#   search <query> [provider]      — full-text search across body/preview
#   recent [provider] [limit]      — most recent messages (default: 20)
#   unnamed [provider]             — contacts stored as raw phone numbers (no name)

DB="$HOME/.config/onemessage/messages.db"
Q() { bun -e "
const { Database } = require('bun:sqlite');
const db = new Database('$DB');
const rows = db.query(\`$1\`).all($2);
if (rows.length === 0) { console.log('(no results)'); process.exit(0); }
rows.forEach(r => console.log(Object.values(r).join(' | ')));
" 2>/dev/null; }

CMD="${1:-stats}"

case "$CMD" in

  stats)
    echo "=== Message counts by provider ==="
    bun -e "
const { Database } = require('bun:sqlite');
const db = new Database('$DB');
const rows = db.query(\"SELECT provider, direction, COUNT(*) as n FROM messages GROUP BY provider, direction ORDER BY provider, direction\").all();
rows.forEach(r => console.log(r.provider.padEnd(12), r.direction.padEnd(4), r.n + ' messages'));
const total = db.query('SELECT COUNT(*) as n FROM messages').get();
console.log('');
console.log('TOTAL'.padEnd(17), total.n + ' messages');
" 2>/dev/null
    ;;

  contacts)
    PROVIDER="${2:-whatsapp}"
    echo "=== Contacts in $PROVIDER (by message count) ==="
    bun -e "
const { Database } = require('bun:sqlite');
const db = new Database('$DB');

// Prefer contacts table if it exists and has data
let hasContactsTable = false;
try {
  const check = db.query(\"SELECT COUNT(*) as n FROM contacts WHERE provider = '$PROVIDER'\").get();
  hasContactsTable = check.n > 0;
} catch {}

if (hasContactsTable) {
  const rows = db.query(\"
    SELECT
      c.name,
      c.address,
      COALESCE(m.cnt, 0) as messages,
      COALESCE(m.last_seen, c.updated_at) as last_seen
    FROM contacts c
    LEFT JOIN (
      SELECT
        json_extract(from_json, '$.address') as address,
        COUNT(*) as cnt,
        MAX(date) as last_seen
      FROM messages
      WHERE provider = '$PROVIDER' AND direction = 'in'
      GROUP BY address
    ) m ON m.address = c.address
    WHERE c.provider = '$PROVIDER'
    ORDER BY messages DESC
    LIMIT 50
  \").all();
  rows.forEach(r => {
    console.log(String(r.messages).padStart(4), r.name?.padEnd(35), r.last_seen?.slice(0,10));
  });
} else {
  // Fallback: query messages directly
  const rows = db.query(\"
    SELECT
      json_extract(from_json, '$.name') as name,
      json_extract(from_json, '$.address') as address,
      COUNT(*) as messages,
      MAX(date) as last_seen
    FROM messages
    WHERE provider = '$PROVIDER' AND direction = 'in'
    GROUP BY address
    ORDER BY messages DESC
    LIMIT 50
  \").all();
  rows.forEach(r => {
    const label = (r.name && r.name !== r.address) ? r.name : r.address;
    console.log(String(r.messages).padStart(4), label?.padEnd(35), r.last_seen?.slice(0,10));
  });
}
" 2>/dev/null
    ;;

  thread)
    NUMBER="${2//+/}"
    PROVIDER="${3:-whatsapp}"
    echo "=== Thread with $2 ($PROVIDER) ==="
    bun -e "
const { Database } = require('bun:sqlite');
const db = new Database('$DB');
const rows = db.query(\"
  SELECT direction, date, body, preview
  FROM messages
  WHERE provider = '$PROVIDER'
    AND (from_json LIKE '%$NUMBER%' OR to_json LIKE '%$NUMBER%')
  ORDER BY date ASC
  LIMIT 100
\").all();
if (rows.length === 0) { console.log('(no messages)'); process.exit(0); }
rows.forEach(r => {
  const who = r.direction === 'in' ? '← THEM' : '→ YOU ';
  const text = (r.body || r.preview || '').slice(0, 120);
  console.log(r.date?.slice(0,10), who, text);
});
" 2>/dev/null
    ;;

  between)
    NUMBER="${2//+/}"
    PROVIDER="${3:-whatsapp}"
    echo "=== Summary: messages with $2 ($PROVIDER) ==="
    bun -e "
const { Database } = require('bun:sqlite');
const db = new Database('$DB');
const total  = db.query(\"SELECT COUNT(*) as n FROM messages WHERE provider='$PROVIDER' AND (from_json LIKE '%$NUMBER%' OR to_json LIKE '%$NUMBER%')\").get();
const from   = db.query(\"SELECT COUNT(*) as n FROM messages WHERE provider='$PROVIDER' AND direction='in'  AND from_json LIKE '%$NUMBER%'\").get();
const to     = db.query(\"SELECT COUNT(*) as n FROM messages WHERE provider='$PROVIDER' AND direction='out' AND to_json   LIKE '%$NUMBER%'\").get();
const oldest = db.query(\"SELECT date FROM messages WHERE provider='$PROVIDER' AND (from_json LIKE '%$NUMBER%' OR to_json LIKE '%$NUMBER%') ORDER BY date ASC  LIMIT 1\").get();
const newest = db.query(\"SELECT date FROM messages WHERE provider='$PROVIDER' AND (from_json LIKE '%$NUMBER%' OR to_json LIKE '%$NUMBER%') ORDER BY date DESC LIMIT 1\").get();
console.log('Total messages :', total.n);
console.log('From them      :', from.n);
console.log('From you       :', to.n);
console.log('First message  :', oldest?.date?.slice(0,10) ?? 'unknown');
console.log('Last message   :', newest?.date?.slice(0,10) ?? 'unknown');
" 2>/dev/null
    ;;

  search)
    QUERY="$2"
    PROVIDER="${3}"
    PROVIDER_FILTER=""
    [[ -n "$PROVIDER" ]] && PROVIDER_FILTER="AND provider = '$PROVIDER'"
    echo "=== Search: \"$QUERY\" ==="
    bun -e "
const { Database } = require('bun:sqlite');
const db = new Database('$DB');
const rows = db.query(\"
  SELECT provider, json_extract(from_json, '$.name') as name,
         json_extract(from_json, '$.address') as address,
         date, preview
  FROM messages
  WHERE (body LIKE '%$QUERY%' OR preview LIKE '%$QUERY%')
  $PROVIDER_FILTER
  ORDER BY date DESC
  LIMIT 20
\").all();
if (rows.length === 0) { console.log('(no results)'); process.exit(0); }
rows.forEach(r => {
  const who = r.name && r.name !== r.address ? r.name : r.address;
  console.log(r.date?.slice(0,10), r.provider?.padEnd(10), who?.padEnd(25), (r.preview||'').slice(0,80));
});
" 2>/dev/null
    ;;

  recent)
    PROVIDER="${2:-whatsapp}"
    LIMIT="${3:-20}"
    echo "=== Recent messages ($PROVIDER, last $LIMIT) ==="
    bun -e "
const { Database } = require('bun:sqlite');
const db = new Database('$DB');
const rows = db.query(\"
  SELECT direction, json_extract(from_json, '$.name') as name,
         json_extract(from_json, '$.address') as address,
         date, preview
  FROM messages
  WHERE provider = '$PROVIDER'
  ORDER BY date DESC
  LIMIT $LIMIT
\").all();
rows.forEach(r => {
  const who = r.direction === 'in'
    ? (r.name && r.name !== r.address ? r.name : r.address)
    : 'YOU';
  console.log(r.date?.slice(0,10), who?.padEnd(30), (r.preview||'').slice(0,80));
});
" 2>/dev/null
    ;;

  unnamed)
    PROVIDER="${2:-whatsapp}"
    echo "=== Unnamed contacts in $PROVIDER (phone numbers only) ==="
    bun -e "
const { Database } = require('bun:sqlite');
const db = new Database('$DB');
const rows = db.query(\"
  SELECT
    json_extract(from_json, '$.address') as address,
    COUNT(*) as messages,
    MAX(date) as last_seen
  FROM messages
  WHERE provider = '$PROVIDER'
    AND direction = 'in'
    AND (json_extract(from_json, '$.name') IS NULL
      OR json_extract(from_json, '$.name') = json_extract(from_json, '$.address'))
  GROUP BY address
  ORDER BY messages DESC
  LIMIT 30
\").all();
rows.forEach(r => console.log(String(r.messages).padStart(4), r.address?.padEnd(30), r.last_seen?.slice(0,10)));
" 2>/dev/null
    ;;

  *)
    echo "Unknown command: $CMD"
    echo "Usage: $0 <stats|contacts|thread|between|search|recent|unnamed> [args]"
    exit 1
    ;;
esac
