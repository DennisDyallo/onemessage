# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
bun run check          # Type-check (tsc --noEmit)
bun run lint           # Lint (Biome, strict recommended rules)
bun run lint:fix       # Lint and auto-fix
bun run format         # Format (Biome)
bun test               # Run tests (56 tests across 6 files)
bun run start          # Run CLI directly (same as: bun src/cli.ts)
bun link               # Make `onemessage` available globally
onemessage status      # Verify providers are configured
onemessage daemon status  # Check if background daemon is running
```

## Tech Stack

- Runtime: Bun (TypeScript, no transpile step)
- CLI framework: Commander
- Database: SQLite via `bun:sqlite` (WAL mode)
- WhatsApp: @whiskeysockets/baileys (direct protocol, no external binary)
- Email: nodemailer (SMTP) + imapflow (IMAP), designed for Proton Mail Bridge
- Signal: shells out to `signal-cli` (external binary)
- SMS: shells out to `kdeconnect-cli` (external binary)

## Architecture

### CLI dispatch

Verb-first CLI (`onemessage <command> <provider> [options]`). Entry point is `src/cli.ts`. All commands go through the provider registry — providers self-register at import time via `registerProvider()` in `src/registry.ts`.

### Provider pattern

Each provider implements `MessagingProvider` (defined in `src/types.ts`): `send`, `inbox`, `read`, and optionally `search`. Providers live in `src/providers/<name>.ts` and are barrel-imported via `src/providers/index.ts`.

Two provider styles exist:
- **Shell providers** (Signal, SMS): use `runCli`/`runCliAsync` from `src/providers/shared.ts` to invoke external CLIs, parse their JSON/text output
- **Library providers** (Email, WhatsApp): use npm packages directly

### Daemon adapter architecture

The **unified daemon** (`src/daemon.ts`) is a thin orchestrator (~350 LOC) that delegates all provider-specific logic to **adapter classes** implementing the `ProviderAdapter` interface from `src/daemon-adapter.ts`.

| Adapter | File | Mode | Notes |
|---------|------|------|-------|
| WhatsApp | `daemon-whatsapp.ts` | Real-time | Baileys WebSocket, implements `IpcCapableAdapter` for send/resolve-group/list-groups |
| Signal | `daemon-signal.ts` | Poll or daemon | signal-cli subprocess (daemon mode) or polling |
| Email | `daemon-email.ts` | Polling | IMAP via imapflow |
| SMS | `daemon-sms.ts` | Polling | KDE Connect CLI |
| Telegram | `daemon-telegram-bot.ts` | Polling | Bot API |
| Instagram | `daemon-instagram.ts` | Polling | instagram-cli |
| Matrix | `daemon-matrix.ts` | Polling | Matrix CS API /sync |

**Key interfaces:**
- `ProviderAdapter` — base interface: `start()`, `fetch()`, `isActive()`, `statusInfo()`, `cleanup()`, `readonly polling: boolean`
- `IpcCapableAdapter` extends `ProviderAdapter` — adds `handleIpc()` for provider-specific IPC commands (only WhatsApp uses this)
- `DaemonOrchestrator` — callback interface passed to `start()` for scheduling polls

The daemon has **zero provider-name string literals** — all dispatch is via adapter iteration. Adapters self-classify as real-time (`polling = false`) or polling (`polling = true`).

The WhatsApp CLI provider (`src/providers/whatsapp.ts`) is a thin IPC client — it calls `ensureDaemon()` from `src/daemon-shared.ts` to auto-start the daemon, then sends requests over the Unix socket.

Baileys socket creation is shared between auth and daemon via `src/whatsapp-shared.ts`.

### Cache layer

`src/store.ts` provides a SQLite message cache. Key concepts:
- **Freshness gating**: `isFresh(provider, maxAgeMs)` checks `fetch_log` table — providers skip re-fetch if data is recent enough. `--fresh` flag bypasses this.
- **Two upsert paths**: `upsertMessages` (envelope-only, from inbox listings) and `upsertFullMessages` (with body, from receive/read operations)
- **Thread support**: SMS conversations use `thread_id` column; thread messages are excluded from inbox listings

### Config

Single JSON file at `~/.config/onemessage/config.json`. Schema in `src/config.ts`. Each provider has its own config interface. The daemon config (`daemon.providers.*`) controls per-provider polling intervals and enable/disable.

## Design Philosophy

onemessage is a **multi-provider SDK**, not a personal script. Every design decision must work for a user on any provider, not just the one that prompted the feature. Before proposing any new feature or config field, ask: *"Would this work identically if the user switched providers?"*

### Commands are provider-agnostic

CLI commands implement *capabilities*, not provider-specific behaviours. A command never hard-codes a provider name in its implementation — the provider is always a config or runtime decision.

```
// WRONG — onemessage me is now secretly a telegram command
const provider = getProviderOrExit("telegram-bot");
const chatId = config.telegramBot?.myChatId;

// RIGHT — me resolves its own provider from config
const { provider, recipientId } = config.me;
const p = getProviderOrExit(provider);
await p.send(recipientId, body);
```

### Provider config holds only provider-local state

A provider's config interface (`EmailProviderConfig`, `TelegramBotProviderConfig`, etc.) must contain only credentials and settings that are meaningless outside that provider: auth tokens, server addresses, account identifiers. Cross-application concepts belong one level up in `OneMessageConfig`.

**Signal:** If a config field would make sense on two different providers, it does not belong inside either provider's interface.

```
// WRONG — myChatId is a cross-cutting concept dressed as provider config
interface TelegramBotProviderConfig {
  botToken: string;
  myChatId?: string;  // ← this is really "self-messaging target", not telegram state
}

// RIGHT — self-messaging target is a top-level config concept
interface MeConfig {
  provider: string;     // any registered provider
  recipientId: string;  // address on that provider
}
interface OneMessageConfig {
  me?: MeConfig;
  telegramBot?: TelegramBotProviderConfig;
}
```

### Provider names are a reserved namespace

Provider names in the CLI and config are a public contract. Use the most general name for the most complete implementation. Qualify the name when an implementation covers only a subset of the platform.

```
// WRONG — "telegram" implies full Telegram (send as yourself, full inbox)
// but the Bot API only sends as a bot and can't initiate conversations
name: "telegram"

// RIGHT — qualifier signals the scope; "telegram" stays free for a future
// MTProto user-auth provider that sends as the user's personal account
name: "telegram-bot"
```

### Convention over configuration

When a pattern appears identically across multiple providers, it is a **convention** — not an optional style. The shared utilities in `src/providers/shared.ts` are the canonical implementation of those conventions. Using them is mandatory; reimplementing equivalent logic inline is always wrong, even if the inline version is correct, because it creates drift and breaks consistency for future readers.

**Shared conventions — reach for these before writing any new code:**

| Utility | When to use |
|---|---|
| `readFromCacheOrFail(provider, messageId)` | Every `read()` implementation where the provider has no random-access fetch API (Signal, SMS, Telegram bot, WhatsApp) |
| `cacheSentMessage({ provider, messageId, fromAddress, recipientId, body })` | Every `send()` implementation after a successful send |
| `runCli(cmd, args, opts)` | Every shell-provider CLI invocation in a synchronous (CLI) context |
| `runCliAsync(cmd, args, opts)` | Every shell-provider CLI invocation in an async (daemon) context |
| `cliExists(cmd)` | Every `isConfigured()` that depends on an external binary |
| `store.isFresh(provider, maxAgeMs, account)` | Every `inbox()` freshness gate |
| `store.getCachedInbox(provider, opts)` | Every `inbox()` return path (both cache-hit and post-fetch) |
| `store.searchCached(query, provider, opts)` | Every `search()` implementation |
| `registerProvider(provider)` at module scope | Every provider file — self-registers on import, no manual wiring |

**Canonical `inbox()` pattern** — copy this exactly, do not invent a variation:

```typescript
async inbox(opts) {
  const settings = resolveSettings(opts?.providerFlags);
  if (!settings) {
    console.error("X not configured. Run: onemessage auth x");
    return [];
  }

  if (store.isFresh("x", 30_000, settings.account) && !opts?.fresh) {
    return store.getCachedInbox("x", { limit: opts?.limit, unread: opts?.unread, since: opts?.since, from: opts?.from });
  }

  await fetchXInbox(settings); // provider-specific fetch + store.upsertMessages/upsertFullMessages

  return store.getCachedInbox("x", { limit: opts?.limit, unread: opts?.unread, since: opts?.since, from: opts?.from });
},
```

```
// WRONG — reimplements caching and error handling inline
async read(messageId) {
  const msg = store.db.query("SELECT * FROM messages WHERE id = ?").get(messageId);
  if (!msg) { console.error("not found"); return null; }
  return msg;
}

// RIGHT — convention handles this universally
async read(messageId) {
  return readFromCacheOrFail("x", messageId);
}
```

### New features: the multi-user test

Before adding any feature, run it through this filter:

1. **Would a user on Signal/Email/WhatsApp want this too?** → implement at the command level, config key above providers
2. **Is this specific to one provider's API?** → implement inside that provider, surfaced via `providerFlags` if the CLI needs to expose it
3. **Does this name reserve a namespace?** → choose the name that leaves room for the complete implementation later

## Adding a New Provider

1. Create `src/providers/<name>.ts` implementing `MessagingProvider`
2. Import shared utilities from `./shared.ts` (`runCli`, `cacheSentMessage`, etc.)
3. Call `registerProvider()` at module scope
4. Add import to `src/providers/index.ts`
5. Add config interface to `src/config.ts`
6. Add auth instructions to the `auth` command switch in `src/cli.ts`
7. Create `src/daemon-<name>.ts` implementing `ProviderAdapter` (use `daemon-email.ts` as template)
8. Add the adapter to the `adapters` array in `daemon.ts` `startAdapters()`
9. Add `<name>?: { enabled?: boolean; pollIntervalMs?: number }` to `DaemonConfig.providers` in `config.ts`

## Async vs Sync CLI calls

`src/providers/shared.ts` has both `runCli` (sync, `Bun.spawnSync`) and `runCliAsync` (async, `Bun.spawn`). Use sync in CLI context (user waits for result), async in daemon context (must not block the event loop during polling).

## Database Queries

Use `scripts/db-query.sh` for consistent SQLite inspection — never write ad hoc bun/SQL one-liners when these cover it:

```bash
./scripts/db-query.sh stats                        # message counts by provider
./scripts/db-query.sh contacts [provider]          # all contacts ranked by message count
./scripts/db-query.sh thread <+number> [provider]  # full conversation thread
./scripts/db-query.sh between <+number> [provider] # count + date range with a contact
./scripts/db-query.sh search <query> [provider]    # full-text search across all messages
./scripts/db-query.sh recent [provider] [limit]    # most recent messages (default 20)
./scripts/db-query.sh unnamed [provider]           # contacts stored as raw phone numbers
```

```bash
bun scripts/backfill-contacts.ts [provider]        # extract pushNames from messages → contacts table
                                                   # run after re-auth or history sync to repopulate names
```

DB path: `~/.config/onemessage/messages.db`

## Instagram Rate Limiting

Instagram aggressively detects bot-like behaviour. The Instagram provider must be gentle:

- **MAX_THREADS_PER_SYNC = 1** — never fetch more than 1 thread history per sync cycle. Instagram's API is slow and rate-limited.
- **CLI_TIMEOUT_MS = 60s** — `instagram-cli` has significant Node.js startup overhead (~2-5s per invocation)
- **No aggressive pagination** — fetch only the latest page (20 messages) per thread. Do not chase cursors or attempt to backfill full history.
- **Inbox limit stays at 20** — the `--limit 20` on inbox fetch is intentional. Instagram threads are summaries, not messages.
- **Thread reads rotate naturally** — most recently active threads get priority. Over multiple sync cycles, all threads eventually get fetched.
- **If Instagram auth expires or rate-limits**, the sync daemon gracefully skips it and continues with other providers.
- **`read()` with `--fresh` re-fetches the thread** — Unlike other cache-only providers, Instagram threads may have uncached sub-messages (because `MAX_THREADS_PER_SYNC` limits how many threads are fetched per cycle). The `--fresh` flag on `read()` calls `fetchThreadMessages()` to backfill before returning from cache. This is intentional and does not violate the `readFromCacheOrFail` convention — it extends it with a targeted pre-fetch.

## Maintenance

signal-cli must be updated every ~3 months or Signal's servers reject it: `brew upgrade signal-cli`
