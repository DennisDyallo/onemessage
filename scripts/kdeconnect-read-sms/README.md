# kdeconnect-read-sms

Read SMS conversations from a paired Android phone via the [KDE Connect](https://kdeconnect.kde.org) daemon's DBus interface.

Part of the [onemessage](../../) project. Fills the gap in `src/providers/sms.ts` — `inbox()` and `read()` currently stub out with "not supported". This script backs those methods.

---

## Requirements

| Dependency | Install |
|------------|---------|
| macOS (arm64 or x86_64) | — |
| [KDE Connect nightly](https://kdeconnect.kde.org/download.html) | Download DMG, install, launch |
| Android phone, paired via KDE Connect | Open KDE Connect app → pair |
| `dbus` (brew) | `brew install dbus` |
| `dbus-python` | `pip3 install dbus-python` |

KDE Connect must be **running** (check menu bar) whenever this script is invoked. The phone must be **reachable** — same WiFi or Tailscale.

---

## Install

```bash
# Make executable (already done if cloned from repo)
chmod +x scripts/kdeconnect-read-sms/kdeconnect-read-sms

# Optional: put on PATH
ln -s "$(pwd)/scripts/kdeconnect-read-sms/kdeconnect-read-sms" ~/bin/kdeconnect-read-sms
```

---

## Usage

```bash
kdeconnect-read-sms                        # all conversations, newest first
kdeconnect-read-sms --unread               # unread only
kdeconnect-read-sms --thread "+46737..."   # filter by contact name or number
kdeconnect-read-sms --refresh              # pull fresh data from phone (~3s), then list
kdeconnect-read-sms --json                 # JSON output (composes with all filters)
kdeconnect-read-sms --json --unread        # unread as JSON
kdeconnect-read-sms --json --refresh       # refresh then output JSON (no progress noise)
```

All flags compose freely. `--json` suppresses all human-readable output — stdout is pure JSON.

---

## Flags

| Flag | Argument | Description |
|------|----------|-------------|
| `--json` | | Output JSON array to stdout. Errors → stderr only. |
| `--unread` | | Filter to unread conversations. |
| `--thread` | `CONTACT` | Filter by contact name or number (substring, case-insensitive). |
| `--refresh` | | Request fresh data from phone before listing (~3s delay). |
| `--device` | `ID` | Override KDE Connect device ID (auto-detected if omitted). |
| `--socket` | `PATH` | Override DBus socket path (auto-detected from `/tmp/dbus-*`). |

---

## Human-readable output

```
CONTACT                        TIME         RD   PREVIEW
────────────────────────────────────────────────────────────────────────────────────────────────────
+46737124377                   00:41        ●    ← Second test — JSON mode
Telia                          2026-03-15   ●    ← Välkommen till Danmark!
+46708866666                   Mon 18:08         → Lugnt

21 conversation(s)
```

| Column | Meaning |
|--------|---------|
| `CONTACT` | Phone number or Android contact name |
| `TIME` | Today → `HH:MM` · this week → `Day HH:MM` · older → `YYYY-MM-DD` |
| `RD` | `●` = unread, blank = read |
| `←` / `→` | Incoming / outgoing |
| `PREVIEW` | Last message body, 55 chars max |

---

## JSON output

Stdout is always a valid JSON array — `[]` if no results. Errors and warnings always go to stderr.

```json
[
  {
    "contact":   "+46737124377",
    "preview":   "Second test — JSON mode",
    "timestamp": "2026-04-08T23:41:31.700000",
    "direction": "in",
    "read":      false,
    "thread_id": 85
  }
]
```

### Schema

```ts
type Conversation = {
  contact:   string;        // phone number or Android contact name
  preview:   string;        // full last message body (not truncated)
  timestamp: string;        // ISO 8601
  direction: "in" | "out";
  read:      boolean;
  thread_id: number;        // stable ID for requesting full conversation history
}

// stdout is always: Conversation[]
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success (array may be empty) |
| non-zero | Fatal: KDE Connect not running, no device, missing dependency |

---

## Integration into onemessage `sms.ts`

`src/providers/sms.ts` currently stubs `inbox()` and `read()`. Wire them up:

```typescript
// inbox() — list conversations
async inbox(opts) {
  const args = ["kdeconnect-read-sms", "--json"];
  if (opts?.unread) args.push("--unread");

  const { stdout, exitCode } = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (exitCode !== 0) return [];

  const convs: Conversation[] = JSON.parse(stdout.toString());
  return convs.map(c => ({
    id:             String(c.thread_id),
    provider:       "sms",
    from:           c.direction === "in" ? { name: c.contact, address: c.contact } : null,
    to:             c.direction === "out" ? [{ name: c.contact, address: c.contact }] : [],
    preview:        c.preview,
    date:           c.timestamp,
    unread:         !c.read,
    hasAttachments: false,
  }));
}
```

---

## Architecture

```
Android KDE Connect app
        ↕ (KDE Connect protocol, TLS+JSON over LAN or Tailscale)
kdeconnectd — KDE Connect daemon (macOS, runs in menu bar)
        ↕ (DBus session at unix:path=/tmp/dbus-<random>)
kdeconnect-read-sms — this script
        ↓ (stdout)
onemessage sms.ts inbox() / AI agents
```

**Auto-detection:** The script scans `/tmp/dbus-*` and verifies `org.kde.kdeconnect` is registered on the socket — safe even if multiple DBus sessions exist.

---

## Known limitations

| Limitation | Notes |
|------------|-------|
| Last message per thread only | Full history needs `requestConversation(thread_id)` + async signal handling — not yet implemented |
| macOS only | KDE Connect daemon is macOS/Linux; Windows not supported |
| Requires KDE Connect running | No daemon = no data; check menu bar icon |
| Contact names from Android | Unknown numbers show as raw digits if not in Android contacts |
| `thread_id` is KDE Connect internal | May differ from Android's SMS thread IDs |
