# RFE: Group Chat Metadata on MessageEnvelope

**Date:** 2026-04-16
**Status:** Proposed
**Author:** Dennis Dyall

## Problem

Downstream consumers of onemessage (e.g., the message-digest daemon in PAI) need to distinguish group chats from direct 1:1 conversations. Group messages carry less signal for personal digests and should be separated or deprioritized in AI-synthesized summaries.

Currently, `MessageEnvelope` has no `isGroup` field. Providers already detect group context internally but don't surface it:

- **Signal** (`signal.ts:185-193`): Detects `groupInfo.groupId` on data messages and embeds it in the contact name as `"Sender [GroupName]"` with address `"group:<id>"`. The information exists but is encoded in a string convention, not a typed field.
- **WhatsApp** (`whatsapp.ts:20-28`): Resolves group JIDs (`@g.us` suffix). The provider knows the difference but doesn't expose it on the envelope.
- **Email**: CC/BCC lists and mailing list headers could indicate group context, but this is lower priority.
- **Telegram Bot**: Group chats have a `chat.title` field and `chat.id` differs from `from.id`.
- **SMS**: No group concept (MMS group threads are rare and provider-dependent).
- **Instagram**: TBD — not fully implemented yet.

## Proposed Change

### 1. Add `isGroup` to `MessageEnvelope`

```typescript
export interface MessageEnvelope {
  id: string;
  provider: string;
  account?: string;
  from: Contact | null;
  to: Contact[];
  subject?: string;
  preview: string;
  date: string;
  unread: boolean;
  hasAttachments: boolean;
  isGroup?: boolean;       // NEW — true for group chats, false for 1:1, undefined if unknown
  groupName?: string;      // NEW — human-readable group name when isGroup is true
}
```

Both fields are optional so existing consumers and providers that don't support group detection continue to work unchanged.

### 2. Provider-specific implementation

| Provider | Detection method | Effort |
|----------|-----------------|--------|
| Signal | `groupInfo.groupId` is already parsed at line 186 — set `isGroup: !!groupId` and `groupName` from the resolved name. Stop encoding group info in the contact name string. | Low |
| WhatsApp | Check if JID ends in `@g.us` (group) vs `@s.whatsapp.net` (individual). The daemon response likely includes this. | Low |
| Telegram Bot | `msg.chat.id !== msg.from?.id` or presence of `chat.title` indicates a group. | Low |
| Email | Optional: check for `List-Id` header or CC count > N. Lower priority. | Medium |
| SMS | Always `isGroup: false` (or omit). | Trivial |
| Instagram | TBD when provider is complete. | Deferred |

### 3. Signal: stop encoding group info in contact name

Currently Signal produces envelopes like:
```json
{
  "from": { "name": "Kla$ [Bitcoin - Freedom - Life]", "address": "group:abc123" },
  "subject": "Bitcoin - Freedom - Life"
}
```

With the new fields, this becomes:
```json
{
  "from": { "name": "Kla$", "address": "+46701234567" },
  "isGroup": true,
  "groupName": "Bitcoin - Freedom - Life",
  "subject": "Bitcoin - Freedom - Life"
}
```

This is a **breaking change** for the contact name format. The `message-sync` daemon in PAI uses the contact name for directory naming (`Sources/Messages/Signal/<ContactName>/`). Migration: the sync daemon would need to handle the new format — contact directories become the sender's name, with a group subdirectory or tag.

**Recommendation:** Keep backward compatibility for one release by continuing to include the `[GroupName]` suffix in the contact name, while also populating the new `isGroup` and `groupName` fields. Deprecate the bracket convention in the next release.

### 4. CLI output

`onemessage inbox --json` should include the new fields in JSON output:

```json
{
  "id": "123",
  "provider": "signal",
  "from": { "name": "Kla$", "address": "+46701234567" },
  "isGroup": true,
  "groupName": "Bitcoin - Freedom - Life",
  "preview": "Cool. Jag är mitt i slutspelet...",
  "date": "2026-04-10T00:32:00.000Z"
}
```

Non-JSON output (table/human mode) could show a `[G]` marker:

```
signal  11:30  [G] Kla$ (Bitcoin - Freedom - Life)  Låter som sagt bra
signal  11:51      Mamma                             Hemma nu
```

### 5. Filtering

New `--group` / `--no-group` flags on `inbox` and `search`:

```bash
onemessage inbox signal --no-group          # Direct messages only
onemessage inbox signal --group             # Group messages only
onemessage inbox --json --no-group          # All providers, direct only
```

## Use Case

The PAI message-digest daemon synthesizes daily/weekly summaries of conversations via AI. Group chats (Telegram groups, Signal groups, WhatsApp groups) tend to be noisy and lower-signal compared to direct conversations. With `isGroup` metadata, the digest can:

1. Separate "Direct Conversations" from "Group Activity" sections in the digest
2. Summarize groups more briefly (1 line per group vs. detailed summaries for 1:1)
3. Allow filtering groups out entirely via `--no-group` when reading messages

## Migration & Backward Compatibility

- `isGroup` and `groupName` are optional — omitting them is valid
- Signal's `[GroupName]` bracket convention in contact names is preserved initially
- No changes required to existing `onemessage send` group syntax (`group:name`)
- The `message-sync` daemon should be updated to use `isGroup`/`groupName` for directory organization after this lands
