# onemessage

Unified messaging CLI — send/reply/inbox/read/search across email, Signal, and SMS from one tool.

## Tech Stack
- Runtime: bun (TypeScript)
- CLI entry: `src/cli.ts`
- Config: `~/.config/onemessage/config.json`
- Cache: `~/.config/onemessage/messages.db` (SQLite via bun:sqlite)

## Architecture
- Verb-first CLI: `onemessage <command> <provider> [options]`
- Provider pattern: each provider implements `MessagingProvider` interface (`src/types.ts`)
- Providers self-register via `registerProvider()` at import time
- Shared utilities in `src/providers/shared.ts` (cliExists, runCli, cacheSentMessage)
- SQLite message cache with freshness gating (`src/store.ts`)

## Adding a New Provider
1. Create `src/providers/<name>.ts` implementing `MessagingProvider`
2. Import shared utilities from `./shared.ts`
3. Call `registerProvider()` at module scope
4. Add import to `src/providers/index.ts`
5. Add config interface to `src/config.ts`
6. Add auth instructions to `src/cli.ts` auth command

## Maintenance

### signal-cli requires regular updates
Signal's servers reject clients older than ~3 months. If `signal-cli` is not updated, `inbox signal` and `send signal` will fail with authentication errors. Update periodically:
```bash
brew upgrade signal-cli
```
