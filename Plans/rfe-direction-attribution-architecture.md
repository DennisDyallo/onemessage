# RFE: Direction & Attribution Architecture Improvements

**Date:** 2026-04-19
**Author:** Dennis + Sia
**Status:** Proposed
**Context:** Post-mortem from fixing message sender attribution across all providers. Outgoing messages were attributed to the contact instead of "me" in the Obsidian vault. Root cause was a two-layer bug: (1) onemessage never exposed the `direction` field from the DB, (2) the vault sync daemon always used `from.name` for sender display. Fixed in commits `d114da5` (onemessage) and `5f7b4fa` (vault daemon).

---

## Cross-Repo Dependency Notice

**onemessage and the vault message-sync daemon are tightly coupled.** The daemon consumes onemessage CLI JSON output. Any change to the message schema, direction semantics, or provider behavior in onemessage must be verified against the message-sync daemon at:

```
~/Documents/Sunthings_AppStorage_EU_e2e/_System/Daemons/message-sync/
```

**Specific coupling points:**

| onemessage component | message-sync consumer | Impact of change |
|---|---|---|
| `MessageEnvelope` / `MessageFull` types | `formatter.ts` local interfaces | Schema mismatch → silent data loss |
| `direction` field semantics | `senderName()` in `formatter.ts` | Wrong attribution if meaning changes |
| `from` / `to` field conventions | `resolveContactName()` in `formatter.ts` | Wrong directory filing |
| `onemessage inbox --json` output | `fetchInbox()` in `sync.ts` | Parse failures, missing messages |
| `onemessage read --thread --json` output | `fetchThreadMessages()` in `sync.ts` | Instagram attribution breaks |
| Provider-specific `isGroup` / `groupName` | `resolveContactDir()` in `formatter.ts` | Group messages misfiled |

**Rule:** When modifying onemessage types, provider output, or direction logic, always check the message-sync daemon interfaces and run its tests:

```bash
bun test ~/Documents/Sunthings_AppStorage_EU_e2e/_System/Daemons/message-sync/sync.test.ts
```

---

## Proposal 1: Eager Instagram Sub-Message Fetching

**Priority:** P0 — Highest impact
**Effort:** Medium (1-2 hours)
**Impact:** Eliminates the root cause of Instagram attribution failures for new threads

### Problem

Instagram threads start as "envelopes" — conversation summaries with no individual messages. The envelope always has `direction: "in"` and `from: contact`, regardless of who sent the last message. Individual messages (with `isOutgoing` flags) are only fetched for `MAX_THREADS_PER_SYNC = 1` thread per sync cycle. New threads sit as attribution-broken envelopes until they happen to be the most-recent thread during a sync.

This means every new Instagram conversation will have wrong attribution until the daemon randomly selects it for sub-message fetching — which could take days or never happen for inactive threads.

### Proposal

Add `--fresh` support to the Instagram provider's `read()` method:

```typescript
// Current: only reads from cache
async read(messageId, _opts) {
  return readFromCacheOrFail("instagram", messageId);
}

// Proposed: fetch from API when --fresh is set
async read(messageId, opts) {
  if (opts?.fresh) {
    const settings = resolveSettings(opts?.providerFlags);
    if (settings) {
      const messages = await fetchThreadMessages(messageId, "?", settings.username);
      if (messages.length > 0) {
        const incoming = messages.filter(m => m.from?.address !== "me");
        const outgoing = messages.filter(m => m.from?.address === "me");
        if (incoming.length > 0) store.upsertFullMessages(incoming, "in", messageId);
        if (outgoing.length > 0) store.upsertFullMessages(outgoing, "out", messageId);
      }
    }
  }
  return readFromCacheOrFail("instagram", messageId);
}
```

Then update the vault sync daemon to request fresh sub-messages when none exist:

```typescript
// In syncProvider(), after threadMsgs is empty:
if (threadMsgs.length === 0) {
  // Try fresh fetch from API
  const freshMsgs = await fetchThreadMessagesFresh(provider, envelope.id);
  if (freshMsgs.length > 0) { /* write them */ }
}
```

### Risks

- Instagram rate limiting if too many fresh fetches happen in one cycle
- Mitigation: limit to 1 fresh fetch per cycle, same as current MAX_THREADS_PER_SYNC

### message-sync daemon changes required

- Add `fetchThreadMessagesFresh()` function that calls `onemessage read instagram <id> --fresh --thread --json`
- Update `syncProvider()` Instagram path to try fresh fetch before falling back to envelope
- Increase `CMD_TIMEOUT_MS` or make it per-provider (Instagram needs 60s+)

---

## Proposal 2: Make `direction` Required on `MessageFull`

**Priority:** P1
**Effort:** Low (30 min)
**Impact:** Eliminates undefined-direction edge cases in all consumers

### Problem

`direction?: "in" | "out"` is optional on both `MessageEnvelope` and `MessageFull`. Every consumer has to handle `undefined` with fallback chains like `msg.direction || envelope?.direction || "?"`. But every message in the DB has a direction (default `"in"`) — the field is never actually absent.

### Proposal

```typescript
// types.ts
export interface MessageEnvelope {
  direction: "in" | "out";  // required, not optional
  // ...
}
```

Update all provider code that constructs messages to explicitly set direction. The DB default (`'in'`) ensures backwards compatibility for existing rows.

### message-sync daemon changes required

- Update local `MessageEnvelope` interface in `formatter.ts` to match
- Simplify `senderName()` — no more fallback chain, just `if (msg.direction === "out")`

---

## Proposal 3: Consistent `from` Field for Outgoing WhatsApp Messages

**Priority:** P1
**Effort:** Medium (1-2 hours)
**Impact:** Fixes WhatsApp directory filing — outgoing messages no longer go to `WhatsApp/Dennis/`

### Problem

The WhatsApp daemon (baileys integration in `src/daemon.ts`) sets `from.name` inconsistently for outgoing messages:
- Some outgoing: `from = { name: "Luke O'Connell", address: "contactPhone" }` (correct — contact name)
- Some outgoing: `from = { name: "Dennis", address: "contactPhone" }` (wrong — user name)

This creates a `WhatsApp/Dennis/` directory in the vault that mixes outgoing messages from different conversations.

### Proposal

In the WhatsApp daemon's message handling, always set `from` to the **contact's** identity for both incoming and outgoing messages. The `direction` field handles who sent what. The `from` field should represent who the conversation is **with**, not who sent this particular message.

```typescript
// For outgoing WhatsApp messages:
from: { name: contactName, address: contactJid }
direction: "out"
```

This matches how the vault daemon uses `from` — to determine the directory name, not the sender.

### message-sync daemon changes required

- None if done correctly — `resolveContactName()` already uses `from.name` for directory resolution
- The `WhatsApp/Dennis/` directory will stop receiving new messages
- Old messages in that directory can be re-synced by clearing processedIds

---

## Proposal 4: Direction-Aware Contact Name Resolution

**Priority:** P2
**Effort:** Low (30 min)
**Impact:** Safety net — correct directory filing even when `from` is wrong

### Problem

`resolveContactName()` in the vault daemon always uses `from.name` for the directory name. For outgoing messages, `from` is unreliable across providers:
- WhatsApp: sometimes the user's name
- Instagram outgoing sub-messages: `{ name: "me", address: "me" }`
- SMS outgoing: always the contact (fixed)
- Email outgoing: the user's email address

### Proposal

Make `resolveContactName()` direction-aware:

```typescript
export function resolveContactName(provider: string, msg: MessageEnvelope): string {
  // Groups take priority
  if (msg.isGroup && msg.groupName) return msg.groupName;

  // For outgoing messages, the contact is in `to`
  if (msg.direction === "out" && msg.to && msg.to.length > 0) {
    const recipient = msg.to[0];
    if (recipient.name?.trim() && recipient.name !== "me") return recipient.name.trim();
    if (recipient.address) return recipient.address;
  }

  // Standard: use from
  if (!msg.from) return "unknown";
  if (provider === "email") return msg.from.address || "unknown";
  return msg.from.name?.trim() || msg.from.address || "unknown";
}
```

This is a safety net — even if Proposal 3 isn't implemented, outgoing messages will file under the correct contact directory.

### message-sync daemon changes required

- This IS the daemon change (in `formatter.ts`)
- Must be done carefully — changing directory names would split existing conversations across two directories unless old files are also migrated

---

## Proposal 5: Self-Healing Instagram Sub-Message Fetching

**Priority:** P2
**Effort:** Medium (1 hour)
**Impact:** Eliminates need for manual backfill scripts

### Problem

The `backfill-instagram-threads.ts` script is a one-time fix. New Instagram threads will continue to start as envelopes. Without periodic backfill, attribution will be wrong for new conversations.

### Proposal

Integrate backfill logic into the sync daemon's normal cycle:

```typescript
// After normal Instagram sync, check for envelope-only threads
const envelopeOnly = getEnvelopeOnlyThreads("instagram"); // new store function
if (envelopeOnly.length > 0) {
  const thread = envelopeOnly[0]; // one per cycle
  await fetchAndStoreThreadMessages(thread.id);
  await log(`Backfilled Instagram thread: ${thread.contact}`);
}
```

Rate limiting: max 1 thread backfilled per Instagram sync cycle (which itself is throttled to every 5-8 cycles). This means ~1 thread per 5-8 minutes — very safe.

### message-sync daemon changes required

- Add `getEnvelopeOnlyThreads()` query to the daemon (or expose via onemessage CLI)
- Add backfill step after Instagram sync in `syncProvider()`
- The Instagram provider needs `--fresh` support (see Proposal 1)

---

## Proposal 6: Test Coverage for Provider Direction Logic

**Priority:** P2
**Effort:** Medium (1-2 hours)
**Impact:** Prevents regression — catches direction bugs before they reach the vault

### Problem

onemessage had zero tests before this fix. The direction bug persisted for months because nothing caught the regression. The 9 tests added today cover the store layer and email detection, but individual provider direction logic is untested.

### Proposal

Add provider-specific direction tests:

```
src/providers/signal.test.ts    — syncMessage detection, from.address matching
src/providers/sms.test.ts       — KDE Connect direction field mapping
src/providers/email.test.ts     — isOutgoingEmail with +tags, case, secondary accounts
src/providers/instagram.test.ts — isOutgoing from API, thread sub-message storage
src/providers/whatsapp.test.ts  — from field consistency for outgoing messages
```

Each test should verify:
1. Incoming messages get `direction: "in"`
2. Outgoing messages get `direction: "out"`
3. The `from` field is set consistently (contact name, not user name)
4. Edge cases: group messages, unknown contacts, missing fields

### message-sync daemon changes required

- None directly, but vault daemon tests should also be expanded:
  - `resolveContactName()` with direction-aware logic
  - `writeMessageToVault()` end-to-end with mock onemessage output
  - Instagram thread vs. envelope handling paths

---

## Implementation Order

| Order | Proposal | Priority | Effort | Blocks |
|-------|----------|----------|--------|--------|
| 1 | P1: Eager Instagram fetch | P0 | Medium | None |
| 2 | P6: Test coverage | P2 | Medium | None |
| 3 | P2: Required direction field | P1 | Low | None |
| 4 | P3: WhatsApp from consistency | P1 | Medium | Investigate daemon.ts |
| 5 | P4: Direction-aware contact name | P2 | Low | P3 first (or as fallback) |
| 6 | P5: Self-healing backfill | P2 | Medium | P1 first |

Proposals 1+5 together form a complete solution for Instagram: P1 handles on-demand fetching, P5 handles background catch-up. Proposals 3+4 together fix WhatsApp directory filing: P3 fixes the data, P4 provides a safety net.

---

## Appendix: Current State After Fix

**Direction distribution (2026-04-19):**

| Provider | In | Out | Status |
|---|---|---|---|
| WhatsApp | 4002 | 2122 | Working (some `from` inconsistency) |
| Instagram | 45 + 141 sub | 11 + 49 sub | Working (all threads backfilled) |
| Signal | 145 | 2 | Code fixed, needs re-sync for historical |
| SMS | 113 | 0 | Code fixed, needs re-sync for historical |
| Email | 345 | 42 | Working (backfilled via SQL) |
| Telegram | 2 | 64 | Not addressed (low priority) |

**Test coverage:**

| Location | Tests | What |
|---|---|---|
| `onemessage/src/store.test.ts` | 3 | Direction persistence in DB read/write |
| `onemessage/src/providers/direction.test.ts` | 6 | Email outgoing detection logic |
| `vault/_System/Daemons/message-sync/sync.test.ts` | 9 | senderName() direction handling |
