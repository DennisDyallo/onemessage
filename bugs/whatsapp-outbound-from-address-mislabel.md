# Bug: WhatsApp outbound messages store the chat-partner's number as `from.address` (account-owner number lost)

- **Reported:** 2026-06-03
- **Status:** Fixed in code for newly ingested messages; no historical cache migration planned.
- **Provider:** `whatsapp` (Baileys)
- **Severity:** High — can route a reply/send to the wrong person; nearly caused a sensitive message to be sent to the wrong recipient.
- **Component:** WhatsApp message ingestion / normalization → SQLite cache (`~/.config/onemessage/messages.db`, `messages.from_json` / `to_json`)

## Summary

For **outbound** WhatsApp messages (`fromMe = true`), the normalized `from.address` is set to the **chat partner's** number instead of the **account owner's** own number. The `from.name` is correct (`"Dennis"`), but the address is wrong. As a result, on outbound rows `from.address === to.address` (both equal the partner), and the account owner's real number **never appears** in the thread cache.

Net effect: you cannot distinguish *self* from *partner* using the cached `from`/`to` addresses, and the data makes it look like the owner's number equals the partner's number.

## Observed (real data)

Account owner's real WhatsApp number, from `~/.config/onemessage/whatsapp/auth/creds.json`:

```
creds.me.id → 46737124377   (this is "Dennis")
```

Rows from the John (tenant) thread in `messages.db` (number `46728418689` is the **partner / John**):

```jsonc
// INBOUND (from John) — mostly OK
{ "direction": "in",
  "from_json": {"name":"John","address":"46728418689"},   // ✓ partner number
  "to_json":   [{"name":"me","address":"me"}] }

// OUTBOUND (from Dennis) — BUG
{ "direction": "out",
  "from_json": {"name":"Dennis","address":"46728418689"},  // ✗ should be 46737124377 (owner)
  "to_json":   [{"name":"John","address":"46728418689"}] } // ✓ partner number
```

Two related symptoms in the same thread:
1. **Outbound `from.address` is the partner's number, not the owner's.** The owner number `46737124377` is never written to any row.
2. At least one **inbound** row (a message authored by the owner on a linked device, synced as history) is labeled `from.name:"Dennis"` with `direction:"in"` and `address:"46728418689"` — direction/sender attribution for multi-device history is also unreliable.

## Impact

- Anything that resolves a recipient from the cache (e.g. `onemessage reply whatsapp <id>`, or contact/identity matching) can pick the wrong address or fail to tell self from partner.
- Identity/dedup logic that keys on `from.address` will conflate the owner with the partner for outbound messages.
- Concretely: while sending a sensitive apartment-sale message, the cache made the tenant's number look identical to the owner's own number. Verification required cross-checking `creds.json` by hand before it was safe to send.

## Root cause (hypothesis)

In the WhatsApp normalizer, the `from` address for a message is derived from the chat's `remoteJid` (the conversation partner) for **all** messages, without branching on `key.fromMe`. For `fromMe` messages the sender should be the **account owner** (`state.creds.me.id`), not the `remoteJid`.

## Suggested fix

In the WhatsApp message→normalized-message mapping:

- Read the owner JID once from Baileys creds: `sock.user?.id` / `state.creds.me?.id` (strip the device/`:NN@s.whatsapp.net` suffix to the bare number).
- For each message:
  - If `key.fromMe`:
    - `from.address` = **owner number**, `from.name` = owner display name
    - `to.address` = chat `remoteJid` (partner / group)
  - Else (inbound):
    - `from.address` = `key.participant ?? remoteJid` (partner; participant for groups)
    - `to.address` = owner number (or group JID for group context)
- Apply the same owner-vs-partner branching to history-synced messages so multi-device backfill doesn't mislabel `direction`/sender.

## Verification after fix

- Re-sync a 1:1 thread and confirm outbound rows have `from.address === <owner number>` and `to.address === <partner number>` (the two differ).
- Confirm the owner number (`creds.me.id`) appears on outbound rows.
- Confirm `onemessage reply whatsapp <id> "..."` resolves to the partner, never to the owner.

## Resolution

Implemented 2026-06-03.

- `parseAndStoreWAMessage` now accepts explicit owner identity from Baileys credentials and prefers `sock.user?.id`, falling back to `creds.me.id`.
- New outbound direct WhatsApp rows store the account owner as `from` and the chat partner as `to`.
- Direct history-sync rows with unreliable `fromMe:false` are conservatively reclassified as outbound only when there is structural owner evidence (`key.participant` normalizes to the owner address) or safe display-name evidence that does not collide with the known partner name.
- Reply routing for outbound cached WhatsApp rows is covered so replies target the partner, not the owner.
- Existing historical rows are intentionally not migrated.

## Verification performed

- `bun test src/tests/integration/whatsapp.test.ts src/providers/whatsapp-shared.test.ts` → `33 pass`, `0 fail`.
- `bun run check` → passed.
- `bun run lint` → passed.
- DevTeam cross-vendor review with `codex exec -m gpt-5.5 --sandbox read-only` → clean pass on iteration 3.
- `bun test` → `312 pass`, `0 fail`.
