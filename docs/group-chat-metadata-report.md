# Group Chat Metadata — Integration Guide

**Commit:** `06c9850` on `main`
**Date:** 2026-04-16
**RFE:** `docs/rfe-group-chat-metadata.md`

## What changed

`MessageEnvelope` now includes two optional fields:

```typescript
interface MessageEnvelope {
  // ... existing fields ...
  isGroup?: boolean;    // true = group chat, false = 1:1, undefined = unknown
  groupName?: string;   // human-readable group name when isGroup is true
}
```

These fields appear in all `--json` output: `inbox`, `read`, and `search`.

## Provider coverage

| Provider | `isGroup` | `groupName` | Detection method |
|----------|-----------|-------------|------------------|
| Signal | Yes | Yes | `groupInfo.groupId` on data messages |
| WhatsApp | Yes | Yes | JID suffix `@g.us` + daemon group cache |
| Telegram Bot | Yes | Yes | `chat.type === "group" \| "supergroup"` |
| Email | No (defaults `false`) | No | Deferred — mailing list detection TBD |
| SMS | No (defaults `false`) | No | SMS has no group concept |
| Instagram | No (defaults `false`) | No | Deferred — provider incomplete |

Providers that don't set `isGroup` return `false` (from database default), not `undefined`.

## JSON output examples

### Group message (Signal)
```json
{
  "id": "1713225600000",
  "provider": "signal",
  "from": { "name": "Kla$ [Bitcoin - Freedom - Life]", "address": "group:abc123" },
  "isGroup": true,
  "groupName": "Bitcoin - Freedom - Life",
  "subject": "Bitcoin - Freedom - Life",
  "preview": "Cool. Jag ar mitt i slutspelet...",
  "date": "2026-04-10T00:32:00.000Z",
  "unread": true,
  "hasAttachments": false
}
```

### Direct message (Signal)
```json
{
  "id": "1713225700000",
  "provider": "signal",
  "from": { "name": "Mamma", "address": "+46701234567" },
  "isGroup": false,
  "preview": "Hemma nu",
  "date": "2026-04-10T00:35:00.000Z",
  "unread": true,
  "hasAttachments": false
}
```

### WhatsApp group
```json
{
  "id": "3EB0A1B2C3D4",
  "provider": "whatsapp",
  "from": { "name": "Erik", "address": "46709876543" },
  "isGroup": true,
  "groupName": "Family Chat",
  "preview": "Ska vi ses pa sondag?",
  "date": "2026-04-15T14:20:00.000Z",
  "unread": true,
  "hasAttachments": false
}
```

## How to use in message-digest

### Filter groups from directs
```bash
# Direct messages only
onemessage inbox --json | jq '[.[] | select(.isGroup | not)]'

# Group messages only
onemessage inbox --json | jq '[.[] | select(.isGroup)]'
```

### Separate digest sections
```typescript
const messages = JSON.parse(execSync("onemessage inbox --json").toString());

const directs = messages.filter(m => !m.isGroup);
const groups  = messages.filter(m => m.isGroup);

// Summarize directs in detail
for (const m of directs) {
  digest.addDetailedSummary(m);
}

// Summarize groups briefly — one line per group
const byGroup = Map.groupBy(groups, m => m.groupName ?? m.from?.address);
for (const [name, msgs] of byGroup) {
  digest.addGroupSummary(name, msgs.length);
}
```

### Group by group name
```bash
onemessage inbox --json | jq '
  [.[] | select(.isGroup)]
  | group_by(.groupName)
  | map({group: .[0].groupName, count: length, latest: (sort_by(.date) | last .date)})
'
```

## Signal backward compatibility note

Signal group messages still use the bracket convention in `from.name`:
```
"from": { "name": "Sender [GroupName]", "address": "group:id" }
```

This is preserved for backward compat. Use `isGroup` and `groupName` for structured access instead of parsing the bracket format. The bracket convention will be deprecated in a future release.

## Not included (future work)

- **CLI filtering flags** (`--group` / `--no-group`) — deferred. Use `jq` filtering on `--json` output for now.
- **Email mailing list detection** — could detect `List-Id` header or CC count.
- **Instagram group detection** — when provider is complete.
- **Signal bracket convention removal** — will be deprecated after downstream consumers migrate to `isGroup`/`groupName`.
