# onemessage

One CLI for all your messengers. Send, read, reply, and search across Email, Signal, WhatsApp, and SMS from a single command.

```
onemessage inbox
onemessage send signal "+46701234567" "Running 10 min late"
onemessage reply email 42 "Sounds good, thanks!"
onemessage search "invoice" --since 2025-01-01
```

## Prerequisites

**Required:**

- [Bun](https://bun.sh) (v1.0+) — the runtime

**Per-provider (install only what you use):**

| Provider | External dependency | Install |
|----------|-------------------|---------|
| Email | [Proton Mail Bridge](https://proton.me/mail/bridge) | Desktop app — runs locally on port 1025/1143 |
| Signal | [signal-cli](https://github.com/AsamK/signal-cli) | `brew install signal-cli` |
| WhatsApp | None | Built-in (uses [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)) |
| SMS | [KDE Connect](https://kdeconnect.kde.org/) | `brew install --cask kdeconnect` (+ paired Android phone) |

## Install

```bash
git clone <repo-url> && cd onemessage
bun install
bun link    # makes `onemessage` available globally
```

Verify it works:

```bash
onemessage --version
onemessage status
```

## Configuration

Create `~/.config/onemessage/config.json`:

```json
{
  "senderName": "Your Name",
  "email": {
    "password": "your-proton-bridge-password",
    "accounts": ["you@protonmail.com"],
    "default": "you@protonmail.com"
  },
  "signal": {
    "phone": "+46701234567"
  },
  "whatsapp": {},
  "sms": {
    "device": "Pixel 8"
  }
}
```

Only include the providers you want to use. Each section is optional.

## Quick Start

```bash
# See which providers are configured
onemessage status

# Check your inbox (all configured providers)
onemessage inbox

# Check one provider
onemessage inbox signal

# Send a message
onemessage send email "friend@example.com" "Hey!" -s "Quick question"
onemessage send signal "+46701234567" "On my way"
onemessage send whatsapp "+46701234567" "See you there"

# Reply to a message (auto-fills recipient)
onemessage reply signal 5 "Got it, thanks"

# Read a full message
onemessage read email 12

# Search across all providers
onemessage search "meeting notes"
onemessage search signal "dinner" --since 2025-03-01
```

## Commands

| Command | Description |
|---------|-------------|
| `send <provider> <recipient> [body]` | Send a message |
| `reply <provider> <messageId> [body]` | Reply (auto-fills recipient from original) |
| `inbox [provider]` | List recent messages (all providers if omitted) |
| `read <provider> <messageId>` | Read a full message |
| `search [provider] <query>` | Search messages |
| `auth <provider>` | Set up or check provider authentication |
| `status` | Show all providers and config status |
| `daemon start\|stop\|status` | Manage background polling daemon |

**Common flags:**

- `--json` — output as JSON (available on all commands)
- `--limit <n>` / `-n <n>` — max messages (default: 10)
- `--fresh` — bypass cache, fetch directly from source
- `--unread` / `-u` — unread messages only
- `--since <date>` — filter by date
- `-s, --subject <text>` — subject line (email)
- `-f, --file <path>` — read message body from file
- `-a, --attach <files...>` — attach files (email)

## Provider Setup

### Email (Proton Mail Bridge)

1. Install and run [Proton Mail Bridge](https://proton.me/mail/bridge)
2. Copy the bridge password from the Bridge app (not your Proton password)
3. Add to config:

```json
{
  "email": {
    "password": "bridge-password-from-app",
    "accounts": ["you@protonmail.com", "alias@pm.me"],
    "default": "you@protonmail.com"
  }
}
```

Bridge runs locally — SMTP on port 1025, IMAP on port 1143. These are the defaults; override with `host`, `smtpPort`, `imapPort` in config if needed.

### Signal

1. Install signal-cli:
   ```bash
   brew install signal-cli
   ```

2. Link to your Signal account:
   ```bash
   onemessage auth signal
   ```
   This shows a QR code — scan it with Signal on your phone (Settings > Linked Devices).

3. Add your phone number to config:
   ```json
   {
     "signal": {
       "phone": "+46701234567"
     }
   }
   ```

**Note:** signal-cli must be updated every ~3 months or Signal's servers will reject it. Run `brew upgrade signal-cli` periodically.

### WhatsApp

1. Run the auth flow:
   ```bash
   onemessage auth whatsapp
   ```
   Scan the QR code with WhatsApp on your phone (Settings > Linked Devices).

   Or use pairing code instead of QR:
   ```bash
   onemessage auth whatsapp --phone +46701234567
   ```

2. That's it — no config needed. Auth state is stored in `~/.config/onemessage/whatsapp-auth/`.

WhatsApp runs through a background daemon that maintains the connection. The daemon starts automatically when you use WhatsApp commands.

### SMS (KDE Connect)

Requires a Linux desktop or macOS with KDE Connect and a paired Android phone.

1. Install KDE Connect on your computer and phone
2. Pair the devices:
   ```bash
   kdeconnect-cli --pair --name "Your Phone"
   ```
3. Find your device name:
   ```bash
   kdeconnect-cli --list-available
   ```
4. Add to config:
   ```json
   {
     "sms": {
       "device": "Pixel 8"
     }
   }
   ```

## Background Daemon

For continuous message polling (useful for vault sync, AI agents, or notifications), run the unified daemon:

```bash
# Run in foreground
onemessage daemon start

# Check status
onemessage daemon status

# Stop
onemessage daemon stop
```

The daemon polls Signal and Email on intervals while maintaining a persistent WhatsApp connection. Configure polling in your config:

```json
{
  "daemon": {
    "pollIntervalMs": 120000,
    "providers": {
      "signal": { "enabled": true, "pollIntervalMs": 60000 },
      "email": { "enabled": true, "pollIntervalMs": 300000 }
    }
  }
}
```

To run as a persistent macOS service (auto-start on boot, restart on crash), create a launchd plist at `~/Library/LaunchAgents/com.onemessage.daemon.plist`.

## JSON Output

Every command supports `--json` for scripting and AI agent integration:

```bash
onemessage inbox signal --json --limit 5
onemessage status --json
onemessage search "project update" --json
```

## Message Cache

Messages are cached locally in SQLite at `~/.config/onemessage/messages.db`. The cache uses freshness gating — subsequent calls within 60 seconds return cached results unless you pass `--fresh`.

## Development

```bash
bun run check    # type-check (tsc --noEmit)
bun run start    # run CLI directly
```

## License

Private — not published.
