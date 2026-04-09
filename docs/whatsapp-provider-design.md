# WhatsApp Provider Design Document

## The Fundamental Constraint

WhatsApp is an always-connected protocol. Baileys (the underlying library) maintains a persistent WebSocket to WhatsApp's servers. onemessage is a CLI that starts, does its thing, and exits. These two models are fundamentally at odds.

This is not a new problem. It is the same constraint that every CLI-over-persistent-protocol tool faces: IMAP IDLE, IRC bouncers, Matrix clients. The solution is always the same pattern: a lightweight daemon that holds the connection, and a thin CLI client that talks to the daemon.

## Recommended Approach: Sidecar Daemon + Unix Socket

### Architecture

```
onemessage send whatsapp +1234567890 "hello"
    |
    v
[whatsapp.ts provider] --- Unix socket IPC ---> [onemessage-whatsapp-daemon]
                                                        |
                                                        v
                                                  [Baileys WASocket]
                                                        |
                                                        v
                                                  WhatsApp servers
```

Two components:

1. **`src/providers/whatsapp.ts`** -- the MessagingProvider implementation. Thin client that talks to the daemon over a Unix socket. Follows the exact same pattern as signal.ts and sms.ts.

2. **`src/whatsapp-daemon.ts`** -- a separate long-running process. Holds the Baileys connection, persists messages to a local SQLite database, and serves requests from the CLI provider over a Unix socket.

### Why Not Connect-Per-Invocation?

Connecting Baileys takes 3-8 seconds (TLS handshake, auth state restore, history sync). Doing this on every `onemessage send whatsapp` call would be:

- Slow (unusable for interactive workflows)
- Ban-risky (repeated connect/disconnect cycles look automated to WhatsApp)
- Unreliable (connection failures, QR re-auth prompts mid-command)

NanoClaw's implementation confirms this: it runs Baileys as a long-lived process with reconnection logic, outgoing message queuing, and connection state tracking. That pattern exists for good reason.

### Why Not Use signal-cli's Approach (Subprocess Per Call)?

signal-cli works as a subprocess because the Signal protocol is designed for it -- signal-cli has a `send` command that connects, sends, and disconnects. There is no equivalent for WhatsApp. Baileys is designed as a persistent connection library. Attempting to wrap it in a connect-send-disconnect cycle per CLI call would fight the library's architecture.

## Library Choice: @whiskeysockets/baileys

**Chosen: Baileys.** Rationale:

| Factor | Baileys | whatsapp-web.js |
|--------|---------|-----------------|
| Runtime | Pure Node.js/TypeScript | Requires Chromium (Puppeteer) |
| Resource usage | ~30MB RAM | ~300MB+ RAM (headless browser) |
| Bun compatibility | Works (NanoClaw proves this) | Puppeteer + Bun = pain |
| Protocol | Direct WebSocket to WA servers | Automates WA Web in browser |
| Maintenance | Active, WhatsApp Multi-Device support | Active but heavier |
| Battle-tested locally | NanoClaw uses it in production | Not tested |

Baileys is the obvious choice. NanoClaw already runs it successfully on this exact machine. whatsapp-web.js would add a Chromium dependency for no benefit.

## Daemon Design

### Process Management

The daemon runs as a background process, managed via a PID file:

```
~/.config/onemessage/whatsapp/daemon.pid    -- PID of running daemon
~/.config/onemessage/whatsapp/daemon.sock   -- Unix socket path
~/.config/onemessage/whatsapp/auth/         -- Baileys auth state (multi-file)
~/.config/onemessage/whatsapp/messages.db   -- received message cache (SQLite)
```

The CLI provider auto-starts the daemon if it is not running. This means the first invocation after boot is slow (~5s to connect) but subsequent calls are instant.

```typescript
// In whatsapp.ts provider:
function ensureDaemon(): void {
  const pidFile = join(getWhatsAppDir(), "daemon.pid");
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim());
    try { process.kill(pid, 0); return; } // Already running
    catch { /* stale PID file, daemon died */ }
  }
  // Spawn daemon as detached background process
  const child = Bun.spawn(["bun", "run", daemonScript], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  child.unref();
  // Wait for socket to appear (poll, max ~8s)
}
```

### IPC Protocol

Simple JSON-over-Unix-socket request/response. Each request is a single JSON line, each response is a single JSON line.

```typescript
// Request types:
{ "cmd": "send", "jid": "1234567890@s.whatsapp.net", "text": "hello" }
{ "cmd": "send", "jid": "1234567890@s.whatsapp.net", "text": "hello", "attachment": "/path/to/file" }
{ "cmd": "inbox", "limit": 10, "since": "2025-01-01T00:00:00Z" }
{ "cmd": "read", "id": "msg-id-here" }
{ "cmd": "search", "query": "meeting", "limit": 10 }
{ "cmd": "status" }
{ "cmd": "stop" }

// Response:
{ "ok": true, "data": { ... } }
{ "ok": false, "error": "Not connected" }
```

### Message Storage

The daemon writes received messages to its own SQLite database (`messages.db` in the whatsapp config dir). The CLI provider reads from this database for inbox/read/search operations and does NOT need to go through the socket for reads -- only for sends and fresh inbox fetches.

This is a deliberate design choice: reads are fast (direct SQLite), writes go through the daemon (which holds the connection). Same pattern as how IMAP clients work with local maildir caches.

### Connection Lifecycle in the Daemon

Borrowed directly from NanoClaw's proven patterns:

- **Startup**: Load auth state, connect Baileys, write PID file, listen on Unix socket
- **Reconnect**: On non-logout disconnects, reconnect automatically with backoff
- **QR/Auth**: If auth state is missing, exit with error code. Auth is handled separately via `onemessage auth whatsapp`
- **Shutdown**: On SIGTERM/SIGINT, clean disconnect, remove PID file and socket
- **Idle timeout**: After 30 minutes of no CLI requests, gracefully disconnect and exit. Next CLI call restarts it. This limits resource usage when onemessage is not being actively used.

### Lessons from NanoClaw Worth Reusing

1. **LID-to-phone JID translation** -- WhatsApp's newer LID format needs mapping back to phone numbers. NanoClaw's `translateJid()` logic handles this.
2. **`normalizeMessageContent()`** -- Baileys wraps messages in various container types (viewOnce, ephemeral, edited). Always call this before extracting text.
3. **`fetchLatestWaWebVersion()`** -- Fetch latest version with graceful fallback on failure.
4. **`Browsers.macOS('Chrome')`** -- Browser identification that WhatsApp accepts.
5. **`makeCacheableSignalKeyStore()`** -- Caches Signal protocol keys for performance.
6. **Outgoing message queue** -- Queue messages when disconnected, flush on reconnect.
7. **515 stream error handling** -- Reconnect on 515 (common after pairing).

### Patterns from NanoClaw to Discard

1. **Group registration/filtering** -- NanoClaw only delivers messages for registered groups. onemessage should capture ALL messages.
2. **Bot message prefixing** -- NanoClaw prefixes messages with the assistant name. Not relevant for a personal CLI.
3. **Typing indicators/presence** -- CLI does not need composing indicators.
4. **OnChatMetadata callbacks** -- NanoClaw-specific routing; not needed.
5. **IPC watcher pattern** -- NanoClaw uses file-based IPC; we use Unix sockets (faster, cleaner).

## Auth Flow

### First-Time Setup: `onemessage auth whatsapp`

Two methods (same as NanoClaw):

**Method A: QR Code (default)**
1. Start the auth script (separate from daemon)
2. Baileys emits QR code data
3. Render QR in terminal via `qrcode-terminal`
4. User scans with WhatsApp -> Settings -> Linked Devices
5. On `connection: 'open'`, save creds, exit

**Method B: Pairing Code (headless/SSH)**
1. `onemessage auth whatsapp --pairing-code --phone 46701234567`
2. Baileys requests pairing code from WhatsApp
3. Display 8-digit code in terminal
4. User enters code in WhatsApp app
5. On `connection: 'open'`, save creds, exit

Auth state persists in `~/.config/onemessage/whatsapp/auth/` (Baileys multi-file format). This directory survives daemon restarts. Re-auth is only needed if the user unlinks the device from WhatsApp.

### Config Structure

```json
{
  "whatsapp": {
    "authDir": "~/.config/onemessage/whatsapp/auth",
    "idleTimeoutMin": 30,
    "phone": "+46701234567"
  }
}
```

All fields are optional. `authDir` defaults to `~/.config/onemessage/whatsapp/auth`. `phone` is stored after successful auth for display purposes (not required for operation -- Baileys uses the auth state). `idleTimeoutMin` controls how long the daemon stays alive without CLI activity.

## MessagingProvider Method Mapping

### `isConfigured()`

Check that auth state exists (creds.json in authDir). No external binary dependency -- Baileys is a npm package bundled with onemessage.

```typescript
isConfigured(): boolean {
  const authDir = getAuthDir();
  return existsSync(join(authDir, "creds.json"));
}
```

### `send(recipientId, body, opts)`

1. Ensure daemon is running (auto-start if needed)
2. Normalize recipientId to JID:
   - `+1234567890` -> `1234567890@s.whatsapp.net`
   - `group:ABCDEF` -> `ABCDEF@g.us`
   - Already a JID -> pass through
3. Send IPC request: `{ cmd: "send", jid, text, attachment? }`
4. Cache sent message via `cacheSentMessage()`
5. Return SendResult

### `inbox(opts)`

1. Check freshness gate (same pattern as signal.ts, 30s default)
2. If stale: send IPC `{ cmd: "inbox" }` to daemon to trigger a fetch of any pending messages
3. Read from daemon's SQLite database (or from onemessage's central cache)
4. Return MessageEnvelope[]

**Design decision**: The daemon continuously receives messages and stores them. The inbox command does not need to "fetch" in the traditional sense -- it just reads what the daemon has already collected. The IPC call is a "hey, make sure you're caught up" nudge, not a data transfer.

### `read(messageId, opts)`

Cache-only read, same as signal.ts:

```typescript
async read(messageId, opts) {
  return readFromCacheOrFail("whatsapp", messageId);
}
```

Messages are cached when inbox is called. WhatsApp has no random-access read API.

### `search(query, opts)`

Cache-only search via `store.searchCached()`, same as signal.ts.

## File Structure

### New Files

```
src/providers/whatsapp.ts          -- MessagingProvider implementation (thin client)
src/whatsapp-daemon.ts             -- Long-running daemon (Baileys connection holder)
src/whatsapp-auth.ts               -- Standalone auth script (QR/pairing code)
```

### Modified Files

```
src/providers/index.ts             -- Add: import "./whatsapp.ts"
src/config.ts                      -- Already has WhatsAppProviderConfig (just needs authDir, phone, idleTimeoutMin)
src/cli.ts                         -- Add whatsapp case to auth command
package.json                       -- Add dependency: @whiskeysockets/baileys, qrcode-terminal
```

### Runtime Directories (created automatically)

```
~/.config/onemessage/whatsapp/
  auth/                            -- Baileys multi-file auth state
  daemon.pid                       -- PID of running daemon
  daemon.sock                      -- Unix socket for IPC
  messages.db                      -- Daemon's message cache
```

## Implementation Plan

### Phase 1: Auth and Daemon Foundation
1. Add `@whiskeysockets/baileys` and `qrcode-terminal` to package.json
2. Create `src/whatsapp-auth.ts` -- standalone auth script with QR + pairing code support
3. Create `src/whatsapp-daemon.ts` -- daemon skeleton with Baileys connection, PID file, Unix socket listener, message storage
4. Add auth instructions to `src/cli.ts`

### Phase 2: Provider Implementation
5. Create `src/providers/whatsapp.ts` -- MessagingProvider with daemon auto-start, IPC client, send/inbox/read/search
6. Add import to `src/providers/index.ts`
7. Update `src/config.ts` if additional config fields are needed

### Phase 3: Polish
8. Add idle timeout to daemon (auto-exit after inactivity)
9. Add `onemessage whatsapp-daemon stop` convenience command (or handle via `onemessage auth whatsapp --stop`)
10. Add daemon status to `onemessage status` output (show connected/disconnected/not-running)
11. Test full flow: auth -> send -> inbox -> read -> search

## Risk Assessment

### Ban Risk (Medium)

WhatsApp actively detects and bans unofficial clients. Mitigation:

- **Use Baileys with browser identification** (`Browsers.macOS('Chrome')`) -- presents as WhatsApp Web, which is a legitimate client.
- **Persistent connection via daemon** -- avoids repeated connect/disconnect cycles that look automated.
- **No bulk operations** -- onemessage is for personal messaging, not marketing.
- **Idle timeout** -- daemon disconnects after 30 min of inactivity, behaving like a user closing their laptop.
- **Rate limit sends** -- if implementing, add a minimum delay between consecutive sends (500ms).

Risk is inherent to any unofficial WhatsApp client. NanoClaw has operated for months without ban issues, which suggests the risk is manageable for personal use.

### Session Persistence (Low Risk)

Baileys' `useMultiFileAuthState` stores credentials in individual files. This is reliable -- NanoClaw uses the same mechanism. Sessions survive daemon restarts and reboots. Re-auth is only needed if the user explicitly unlinks the device from WhatsApp's Linked Devices menu.

### Daemon Reliability (Medium)

The daemon is a single point of failure. If it crashes, CLI commands fail until it restarts. Mitigation:

- **Auto-restart on CLI invocation** -- if daemon is not running, the provider starts it automatically.
- **Graceful error messages** -- if daemon is starting up, tell the user to wait.
- **Crash logging** -- daemon writes logs to `~/.config/onemessage/whatsapp/daemon.log`.
- **No launchd/systemd required** -- the daemon is fully managed by the CLI. No system service configuration needed.

### Baileys Library Stability (Medium)

Baileys is a reverse-engineered protocol library. WhatsApp can break it at any time by changing their protocol. This is the same risk NanoClaw accepts. When Baileys breaks, `bun update @whiskeysockets/baileys` usually fixes it within days (the community is active).

### Resource Usage (Low Risk)

Baileys daemon uses ~30-50MB RAM. The idle timeout ensures it does not run indefinitely. Compared to whatsapp-web.js (300MB+ for Chromium), this is lightweight.

## Config Update for config.ts

The existing `WhatsAppProviderConfig` in config.ts already has `authDir`. Extend it:

```typescript
export interface WhatsAppProviderConfig {
  authDir?: string;       // default: ~/.config/onemessage/whatsapp/auth
  phone?: string;         // stored after auth for display (not functionally required)
  idleTimeoutMin?: number; // default: 30 (daemon auto-exits after this many minutes idle)
}
```

## Summary

The fundamental constraint -- persistent protocol vs CLI invocation model -- is solved with a lightweight daemon that auto-starts on first use and auto-stops after inactivity. This is a well-understood architectural pattern. NanoClaw's Baileys integration provides a proven reference for the WhatsApp-specific concerns (auth flow, message parsing, JID translation, reconnection). The provider implementation follows the exact conventions of signal.ts and sms.ts: config resolution, shared utilities, cache-based read/search, and self-registration.

The key insight from NanoClaw that carries over: WhatsApp's protocol is fundamentally connection-oriented, and fighting that (with connect-per-call) creates more problems than it solves. Embrace the daemon.
