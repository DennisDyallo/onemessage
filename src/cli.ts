#!/usr/bin/env bun
import { Command } from "commander";

// Import providers — each self-registers via registerProvider()
import "./providers/index.ts";

import { getProviderOrExit, getAllProviders } from "./registry.ts";
import { loadConfig, getConfigPath } from "./config.ts";
import { getCachedMessage, getContacts, getPreviousOutboundRecipient } from "./store.ts";
import type { MessageEnvelope, MessageFull } from "./types.ts";

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\n/g, " ");
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

function printEnvelopes(messages: MessageEnvelope[], json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(messages, null, 2) + "\n");
    return;
  }
  if (messages.length === 0) {
    console.log("  (no messages)");
    return;
  }
  for (const m of messages) {
    const marker = m.unread ? "●" : " ";
    const groupTag = m.isGroup ? " [G]" : "";
    const id = pad(m.id, 6);
    const from = truncate((m.from?.name || m.from?.address || "unknown") + groupTag, 24);
    const subj = truncate(m.subject || m.preview || "", 40);
    console.log(`  ${marker} ${id}  ${pad(from, 24)}  ${pad(subj, 40)}  ${formatDate(m.date)}`);
  }
}

function printMessage(msg: MessageFull, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(msg, null, 2) + "\n");
    return;
  }
  console.log();
  console.log(`  From:    ${msg.from?.name || ""} <${msg.from?.address || ""}>`);
  console.log(`  To:      ${msg.to.map((c) => c.address).join(", ")}`);
  if (msg.isGroup && msg.groupName) console.log(`  Group:   ${msg.groupName}`);
  if (msg.subject) console.log(`  Subject: ${msg.subject}`);
  console.log(`  Date:    ${msg.date}`);
  if (msg.hasAttachments) {
    console.log(`  Attach:  ${msg.attachments.map((a) => a.filename).join(", ")}`);
  }
  console.log();
  console.log(msg.body);
}

/**
 * Collect provider-specific CLI flags into a providerFlags object.
 * Only includes keys that were actually passed (not undefined).
 */
function collectProviderFlags(opts: any): Record<string, unknown> | undefined {
  const flags: Record<string, unknown> = {};
  if (opts.password !== undefined) flags.password = opts.password;
  if (opts.sender !== undefined) flags.from = opts.sender;
  if (opts.senderName !== undefined) flags.senderName = opts.senderName;
  if (opts.host !== undefined) flags.host = opts.host;
  if (opts.smtpPort !== undefined) flags.smtpPort = Number(opts.smtpPort);
  if (opts.imapPort !== undefined) flags.imapPort = Number(opts.imapPort);
  if (opts.botToken !== undefined) flags.botToken = opts.botToken;
  if (opts.phone !== undefined) flags.phone = opts.phone;
  if (opts.device !== undefined) flags.device = opts.device;
  return Object.keys(flags).length > 0 ? flags : undefined;
}

// ---------------------------------------------------------------------------
// Shared provider-override flags — added to commands that need them
// ---------------------------------------------------------------------------

function addProviderFlags(cmd: Command): Command {
  return cmd
    .option("--password <password>", "Provider password/token (overrides config)")
    .option("--sender <address>", "Sender address/identity (overrides config default)")
    .option("--sender-name <name>", "Sender display name")
    .option("--host <host>", "Server host (overrides config)")
    .option("--smtp-port <port>", "SMTP port (email)")
    .option("--imap-port <port>", "IMAP port (email)")
    .option("--bot-token <token>", "Bot token (telegram-bot)")
    .option("--phone <number>", "Phone number (signal, sms)")
    .option("--device <name>", "Device name (sms via KDE Connect)");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("onemessage")
  .description("Unified messaging CLI — one command for all your messengers")
  .version("0.1.0");

// ---- send -----------------------------------------------------------------

addProviderFlags(
  program
    .command("send <provider> <recipientId> [body]")
    .description("Send a message via a provider")
    .option("-s, --subject <subject>", "Subject line (email)")
    .option("-f, --file <path>", "Read body from file")
    .option("--html", "Treat body as HTML", false)
    .option("-a, --attach <files...>", "Attach file(s)")
    .option("--cc <addresses...>", "CC recipients (email)")
    .option("--bcc <addresses...>", "BCC recipients (email)")
    .option("--reply-to <address>", "Reply-To address (email)")
    .option("--account <id>", "Sender account (overrides default)")
    .option("--json", "Output JSON", false)
).action(async (providerName, recipientId, body, opts) => {
  const provider = getProviderOrExit(providerName);

  if (!body && !opts.file) {
    console.error("Provide a message body or --file.");
    process.exit(1);
  }

  const result = await provider.send(recipientId, body ?? "", {
    subject: opts.subject,
    html: opts.html,
    file: opts.file,
    attachments: opts.attach,
    cc: opts.cc,
    bcc: opts.bcc,
    replyTo: opts.replyTo,
    account: opts.account ?? opts.sender,
    providerFlags: collectProviderFlags(opts),
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (result.ok) {
    console.log(`  ✓ sent via ${result.provider} → ${result.recipientId}${result.messageId ? ` (${result.messageId})` : ""}`);
  } else {
    console.error(`  ✗ failed: ${result.error}`);
    process.exit(1);
  }
});

// ---- me -------------------------------------------------------------------

program
  .command("me [body]")
  .description("Send a message to yourself (uses config.me provider + recipientId)")
  .option("-f, --file <path>", "Read body from file")
  .action(async (body, opts) => {
    const config = loadConfig();
    const me = config.me;
    if (!me) {
      console.error('  ✗ "me" not configured. Add to config.json:');
      console.error('    { "me": { "provider": "telegram-bot", "recipientId": "<your_chat_id>" } }');
      process.exit(1);
    }

    if (!body && !opts.file) {
      console.error("  ✗ Provide a message body or --file.");
      process.exit(1);
    }

    let resolvedBody = body ?? "";
    if (opts.file) {
      const { readFileSync } = await import("node:fs");
      resolvedBody = readFileSync(opts.file, "utf-8").trim();
    }

    const provider = getProviderOrExit(me.provider);
    const result = await provider.send(me.recipientId, resolvedBody);

    if (result.ok) {
      console.log(`  ✓ sent to self via ${me.provider}`);
    } else {
      console.error(`  ✗ failed: ${result.error}`);
      process.exit(1);
    }
  });

// ---- reply ----------------------------------------------------------------

addProviderFlags(
  program
    .command("reply <provider> <messageId> [body]")
    .description("Reply to a message (auto-fills recipient from original)")
    .option("-s, --subject <subject>", "Override subject (email)")
    .option("-f, --file <path>", "Read body from file")
    .option("--html", "Treat body as HTML", false)
    .option("-a, --attach <files...>", "Attach file(s)")
    .option("--account <id>", "Sender account (overrides default)")
    .option("--json", "Output JSON", false)
).action(async (providerName, messageId, body, opts) => {
  const provider = getProviderOrExit(providerName);

  const original = getCachedMessage(providerName, messageId);
  if (!original) {
    console.error(`Message "${messageId}" not found in cache.`);
    console.error(`Run 'onemessage inbox ${providerName}' first to fetch messages.`);
    process.exit(1);
  }

  const senderAddress = original.from?.address;
  if (!senderAddress) {
    console.error("Cannot reply: original message has no sender address.");
    process.exit(1);
  }

  if (!body && !opts.file) {
    console.error("Provide a reply body or --file.");
    process.exit(1);
  }

  // For email: auto-set subject with Re: prefix and replyTo.
  // Prefer the alias address used in previous outgoing messages over the raw
  // sender address, so SimpleLogin (or similar) aliases are preserved.
  let subject = opts.subject;
  let replyTo: string | undefined;
  let recipient = senderAddress;
  if (providerName === "email") {
    if (!subject && original.subject) {
      subject = original.subject.startsWith("Re: ") ? original.subject : `Re: ${original.subject}`;
    }
    replyTo = senderAddress;
    const emailCfg = loadConfig()?.email;
    const ownAccounts: string[] = emailCfg?.accounts ?? [];
    const previousAlias = subject ? getPreviousOutboundRecipient("email", subject, ownAccounts) : null;
    if (previousAlias) recipient = previousAlias;
  }

  const result = await provider.send(recipient, body ?? "", {
    subject,
    html: opts.html,
    file: opts.file,
    attachments: opts.attach,
    account: opts.account,
    replyTo,
    inReplyTo: original.rfcMessageId,
    providerFlags: collectProviderFlags(opts),
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (result.ok) {
    console.log(`  ✓ replied via ${result.provider} → ${recipient}${result.messageId ? ` (${result.messageId})` : ""}`);
  } else {
    console.error(`  ✗ reply failed: ${result.error}`);
    process.exit(1);
  }
});

// ---- inbox ----------------------------------------------------------------

addProviderFlags(
  program
    .command("inbox [provider]")
    .description("List recent messages (all providers if none specified)")
    .option("-n, --limit <n>", "Max messages", "10")
    .option("-u, --unread", "Unread only", false)
    .option("--since <date>", "Messages since date")
    .option("--from <address>", "Filter by sender")
    .option("--folder <name>", "Folder/chat name")
    .option("--account <id>", "Specific account")
    .option("--fresh", "Force re-fetch from source (bypass cache)", false)
    .option("--all", "Include secondary-account emails", false)
    .option("--json", "Output JSON", false)
).action(async (providerName, opts) => {
  const limit = parseInt(opts.limit, 10) || 10;
  const providerFlags = collectProviderFlags(opts);

  const providers = providerName
    ? [getProviderOrExit(providerName)]
    : getAllProviders().filter((p) => p.isConfigured());

  if (providers.length === 0) {
    console.error("No configured providers. Run: onemessage status");
    process.exit(1);
  }

  const allMessages: MessageEnvelope[] = [];
  for (const provider of providers) {
    try {
      const messages = await provider.inbox({
        limit, unread: opts.unread, since: opts.since,
        from: opts.from, folder: opts.folder, account: opts.account,
        fresh: opts.fresh, all: opts.all,
        providerFlags,
      });
      allMessages.push(...messages);
    } catch (err: any) {
      process.stderr.write(`[${provider.name}] Error: ${err.message}\n`);
    }
  }

  allMessages.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  if (!providerName && !opts.json && allMessages.length > 0) {
    const grouped = new Map<string, MessageEnvelope[]>();
    for (const m of allMessages) {
      const list = grouped.get(m.provider) ?? [];
      list.push(m);
      grouped.set(m.provider, list);
    }
    for (const [name, messages] of grouped) {
      console.log(`\n  ${name}:`);
      printEnvelopes(messages.slice(0, limit), false);
    }
    console.log();
  } else {
    printEnvelopes(providerName ? allMessages.slice(0, limit) : allMessages, opts.json);
  }
});

// ---- read -----------------------------------------------------------------

addProviderFlags(
  program
    .command("read <provider> <messageId>")
    .description("Read a specific message")
    .option("--folder <name>", "Folder/chat")
    .option("--account <id>", "Account that owns the message")
    .option("--prefer <format>", "Body format: text or html", "text")
    .option("--attachments", "Include attachment data", false)
    .option("--fresh", "Force re-fetch from source (bypass cache)", false)
    .option("--json", "Output JSON", false)
).action(async (providerName, messageId, opts) => {
  const provider = getProviderOrExit(providerName);

  const msg = await provider.read(messageId, {
    folder: opts.folder,
    account: opts.account,
    prefer: opts.prefer as "text" | "html",
    includeAttachments: opts.attachments,
    fresh: opts.fresh,
    providerFlags: collectProviderFlags(opts),
  });

  if (!msg) { console.error(`Message "${messageId}" not found.`); process.exit(1); }
  printMessage(msg, opts.json);
});

// ---- search ---------------------------------------------------------------

addProviderFlags(
  program
    .command("search [provider] <query>")
    .description("Search messages")
    .option("-n, --limit <n>", "Max results", "10")
    .option("--folder <name>", "Folder/chat")
    .option("--account <id>", "Specific account")
    .option("--since <date>", "Messages since date")
    .option("--fresh", "Force re-fetch from source (bypass cache)", false)
    .option("--json", "Output JSON", false)
).action(async (providerNameOrQuery, queryOrUndefined, opts) => {
  let providerName: string | undefined;
  let query: string;

  const allNames = getAllProviders().map((p) => p.name);
  if (queryOrUndefined && allNames.includes(providerNameOrQuery)) {
    providerName = providerNameOrQuery;
    query = queryOrUndefined;
  } else {
    query = providerNameOrQuery;
  }

  const limit = parseInt(opts.limit, 10) || 10;
  const providerFlags = collectProviderFlags(opts);
  const providers = providerName
    ? [getProviderOrExit(providerName)]
    : getAllProviders().filter((p) => p.isConfigured());

  const allMessages: MessageEnvelope[] = [];
  for (const provider of providers) {
    if (!provider.search) continue;
    try {
      allMessages.push(...await provider.search(query, {
        limit, folder: opts.folder, account: opts.account, since: opts.since,
        fresh: opts.fresh, providerFlags,
      }));
    } catch (err: any) {
      process.stderr.write(`[${provider.name}] Search error: ${err.message}\n`);
    }
  }

  allMessages.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  printEnvelopes(allMessages.slice(0, limit), opts.json);
});

// ---- auth -----------------------------------------------------------------

program
  .command("auth <provider>")
  .description("Configure or authenticate a provider")
  .option("--phone <number>", "Phone number for WhatsApp pairing code auth")
  .action(async (providerName, opts) => {
    const provider = getProviderOrExit(providerName);
    const configPath = getConfigPath();
    const config = loadConfig();

    if (provider.isConfigured()) {
      console.log(`  ✓ ${providerName} is configured.`);
      const providerConfig = (config as any)[providerName];
      if (providerConfig?.accounts) {
        const accounts: string[] = providerConfig.accounts;
        const defaultAcct = providerConfig.default;
        console.log(`\n  Accounts:`);
        for (const a of accounts) {
          const def = a === defaultAcct ? " (default)" : "";
          console.log(`    · ${a}${def}`);
        }
      }
      console.log(`\n  Config: ${configPath}`);
    } else if (provider.authenticate) {
      await provider.authenticate({ phone: opts.phone });
    } else {
      console.log(`  ${providerName} is not configured.\n`);
      console.log(`  Create ${configPath} with:\n`);

      switch (providerName) {
        case "email":
          console.log(`    {`);
          console.log(`      "senderName": "Your Name",`);
          console.log(`      "email": {`);
          console.log(`        "password": "your-bridge-password",`);
          console.log(`        "accounts": ["you@protonmail.com", "alias@pm.me"],`);
          console.log(`        "default": "you@protonmail.com"`);
          console.log(`      }`);
          console.log(`    }\n`);
          console.log(`  Or pass everything via CLI flags:\n`);
          console.log(`    onemessage send email "to@x.com" -s "Hi" "body" \\`);
          console.log(`      --password "bridge-pw" --from "you@pm.me"\n`);
          break;
        case "telegram-bot":
          console.log(`  Sends messages as a Telegram bot (not your personal account).`);
          console.log(`  The recipient must have started a chat with your bot first.\n`);
          console.log(`  Create a bot via @BotFather on Telegram, then add to ${configPath}:\n`);
          console.log(`    {`);
          console.log(`      "telegramBot": {`);
          console.log(`        "botToken": "123456:ABC-your-token"`);
          console.log(`      },`);
          console.log(`      "me": { "provider": "telegram-bot", "recipientId": "<your_chat_id>" }`);
          console.log(`    }\n`);
          console.log(`  Or pass per-call: onemessage send telegram-bot <chat_id> "hi" --bot-token "123456:ABC..."\n`);
          console.log(`  Find your chat_id: message your bot, then run: onemessage inbox telegram-bot\n`);
          console.log(`  Once "me" is set: onemessage me "hello"  (send to yourself via any provider)\n`);
          break;
        case "sms":
          console.log(`  Requires kdeconnect-cli and a paired Android phone.\n`);
          console.log(`  1. Pair your phone: kdeconnect-cli --pair --name "Your Phone"`);
          console.log(`  2. List devices:    kdeconnect-cli --list-available\n`);
          console.log(`  Then add to config:\n`);
          console.log(`    {`);
          console.log(`      "sms": {`);
          console.log(`        "device": "Pixel 8"`);
          console.log(`      }`);
          console.log(`    }\n`);
          console.log(`  Or: onemessage send sms "+1234567890" "hello" --device "Pixel 8"\n`);
          break;
        case "signal":
          console.log(`  Requires signal-cli: brew install signal-cli\n`);
          console.log(`  Run: onemessage auth signal  (interactive QR linking)\n`);
          console.log(`  Or manually:\n`);
          console.log(`    signal-cli link -n "onemessage"\n`);
          console.log(`  Then add to config:\n`);
          console.log(`    { "signal": { "phone": "+YOUR_NUMBER" } }\n`);
          break;
        default:
          console.log(`  Provider "${providerName}" setup instructions not yet available.`);
      }
    }
  });

// ---- status ---------------------------------------------------------------

program
  .command("status")
  .description("Show all providers and their configuration status")
  .option("--json", "Output JSON", false)
  .action((opts) => {
    const providers = getAllProviders();
    const config = loadConfig();

    if (opts.json) {
      const data = providers.map((p) => ({
        name: p.name,
        displayName: p.displayName,
        configured: p.isConfigured(),
        accounts: ((config as any)[p.name]?.accounts as string[]) ?? [],
      }));
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
      return;
    }

    console.log();
    for (const p of providers) {
      const icon = p.isConfigured() ? "✓" : "·";
      const providerConfig = (config as any)[p.name];
      if (providerConfig?.accounts && Array.isArray(providerConfig.accounts)) {
        const defaultAcct = providerConfig.default;
        const summary = providerConfig.accounts
          .map((a: string) => a === defaultAcct ? `${a} (default)` : a)
          .join(", ");
        console.log(`  ${pad(p.name, 12)} ${icon}  ${summary}`);
      } else if (p.isConfigured()) {
        console.log(`  ${pad(p.name, 12)} ${icon}  ${p.displayName}`);
      } else {
        console.log(`  ${pad(p.name, 12)} ${icon}  not configured`);
      }
    }
    console.log();
  });

// ---- contacts -------------------------------------------------------------

program
  .command("contacts [provider]")
  .description("List known contacts (from contact sync)")
  .option("-n, --limit <n>", "Max contacts to show", "50")
  .option("--search <name>", "Filter contacts by name")
  .option("--json", "Output JSON", false)
  .action((providerName, opts) => {
    const provider = providerName ?? "whatsapp";
    const limit = parseInt(opts.limit, 10) || 50;

    const contacts = getContacts(provider, {
      limit,
      search: opts.search,
    });

    if (opts.json) {
      process.stdout.write(JSON.stringify(contacts, null, 2) + "\n");
      return;
    }

    if (contacts.length === 0) {
      console.log("  (no contacts found)");
      return;
    }

    console.log();
    for (const c of contacts) {
      const count = String(c.messageCount).padStart(4);
      const name = pad(c.name, 24);
      const addr = c.address.match(/^\d+$/) ? `+${c.address}` : c.address;
      const lastDate = c.lastSeen ? c.lastSeen.slice(0, 10) : "";
      console.log(`  ${count}  ${name}  ${pad(addr, 16)}  last: ${lastDate}`);
    }
    console.log();
  });

// ---- daemon ---------------------------------------------------------------

const daemonCmd = program
  .command("daemon")
  .description("Manage the onemessage background daemon");

daemonCmd
  .command("start")
  .description("Start the unified daemon in foreground")
  .action(async () => {
    const { UnifiedDaemon } = await import("./daemon.ts");
    const daemon = new UnifiedDaemon();
    await daemon.start();
  });

daemonCmd
  .command("stop")
  .description("Stop the running daemon")
  .action(async () => {
    const { DAEMON_PID } = await import("./daemon-shared.ts");
    const { existsSync, readFileSync, unlinkSync } = await import("fs");

    if (!existsSync(DAEMON_PID)) {
      console.log("  Daemon is not running (no PID file).");
      return;
    }

    const pidStr = readFileSync(DAEMON_PID, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) {
      console.error("  Invalid PID file. Removing.");
      unlinkSync(DAEMON_PID);
      return;
    }

    try {
      process.kill(pid, 0); // check if alive
      process.kill(pid, "SIGTERM");
      console.log(`  Sent SIGTERM to daemon (pid=${pid}).`);
    } catch {
      console.log("  Daemon is not running. Cleaning up stale PID file.");
      try { unlinkSync(DAEMON_PID); } catch {}
    }
  });

daemonCmd
  .command("restart")
  .description("Restart the daemon (launchctl if managed, otherwise stop + start)")
  .action(async () => {
    const PLIST = `${process.env.HOME}/Library/LaunchAgents/com.onemessage.daemon.plist`;
    const { existsSync } = await import("fs");
    const { DAEMON_SOCK, isDaemonRunning } = await import("./daemon-shared.ts");

    if (existsSync(PLIST)) {
      // Managed by launchd — unload/load so launchd owns the restart (no competing spawns)
      Bun.spawnSync(["launchctl", "unload", PLIST], { stdio: ["ignore", "inherit", "inherit"] });
      await new Promise((r) => setTimeout(r, 2000));
      Bun.spawnSync(["launchctl", "load", PLIST], { stdio: ["ignore", "inherit", "inherit"] });
      // Wait for socket
      const maxWait = 10_000;
      let waited = 0;
      while (waited < maxWait) {
        if (existsSync(DAEMON_SOCK) && isDaemonRunning()) {
          console.log("  Daemon restarted (via launchctl).");
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
        waited += 200;
      }
      console.error("  Daemon failed to start within 10 seconds.");
      return;
    }

    // Not managed by launchd — stop + spawn manually
    const { DAEMON_PID } = await import("./daemon-shared.ts");
    const { readFileSync, unlinkSync } = await import("fs");
    if (existsSync(DAEMON_PID)) {
      const pid = parseInt(readFileSync(DAEMON_PID, "utf-8").trim(), 10);
      if (!isNaN(pid)) {
        try { process.kill(pid, "SIGTERM"); console.log(`  Sent SIGTERM to daemon (pid=${pid}).`); } catch {}
      }
    }
    const deadline = Date.now() + 5000;
    while (isDaemonRunning() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    try { if (existsSync(DAEMON_SOCK)) unlinkSync(DAEMON_SOCK); } catch {}
    const { join, dirname } = await import("path");
    const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
    const proc = Bun.spawn(["bun", "run", "src/daemon.ts"], {
      cwd: PROJECT_ROOT, stdio: ["ignore", "ignore", "ignore"], detached: true,
    });
    proc.unref();
    let waited2 = 0;
    while (waited2 < 10_000) {
      if (existsSync(DAEMON_SOCK) && isDaemonRunning()) { console.log("  Daemon restarted."); return; }
      await new Promise((r) => setTimeout(r, 200));
      waited2 += 200;
    }
    console.error("  Daemon failed to start within 10 seconds.");
  });

daemonCmd
  .command("status")
  .description("Show daemon status")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const { isDaemonRunning, daemonRequest } = await import("./daemon-shared.ts");

    if (!isDaemonRunning()) {
      if (opts.json) {
        process.stdout.write(JSON.stringify({ running: false }) + "\n");
      } else {
        console.log("  Daemon is not running.");
      }
      return;
    }

    try {
      const res = await daemonRequest({ type: "status" });
      if (opts.json) {
        process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
        return;
      }

      const d = res.data as any;
      console.log();
      console.log(`  Daemon running (pid=${d.pid}, uptime=${d.uptime}s)`);
      console.log();

      // WhatsApp
      const wa = d.whatsapp;
      const waIcon = wa.connected ? "+" : "-";
      console.log(`  ${waIcon} whatsapp: ${wa.connected ? "connected" : "disconnected"} (${wa.groups} groups, ${wa.queuedMessages} queued)`);

      // Polling providers
      const polling = d.polling as Record<string, { lastPoll: string | null; enabled: boolean }>;
      for (const [name, info] of Object.entries(polling)) {
        const icon = info.enabled ? "+" : "-";
        const last = info.lastPoll ? `last: ${info.lastPoll}` : "never polled";
        console.log(`  ${icon} ${name}: ${info.enabled ? "enabled" : "disabled"} (${last})`);
      }
      console.log();
    } catch (err: any) {
      if (opts.json) {
        process.stdout.write(JSON.stringify({ running: true, error: err.message }) + "\n");
      } else {
        console.error(`  Daemon is running but not responding: ${err.message}`);
      }
    }
  });

program.parse();
