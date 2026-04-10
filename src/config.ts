import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Config shape — flat and slim
// ---------------------------------------------------------------------------

export interface OneMessageConfig {
  senderName?: string;
  email?: EmailProviderConfig;
  telegram?: TelegramProviderConfig;
  signal?: SignalProviderConfig;
  sms?: SmsProviderConfig;
  whatsapp?: WhatsAppProviderConfig;
  daemon?: DaemonConfig;
}

export interface DaemonConfig {
  pollIntervalMs?: number;
  providers?: {
    signal?: { enabled?: boolean; pollIntervalMs?: number };
    email?: { enabled?: boolean; pollIntervalMs?: number };
    sms?: { enabled?: boolean; pollIntervalMs?: number };
  };
}

export interface EmailProviderConfig {
  password: string;
  accounts: string[];
  default?: string;
  // Accounts whose messages are hidden from default inbox (shown with --all)
  secondaryAccounts?: string[];
  // Overrides — only needed if not using standard Proton Bridge
  host?: string;       // default: 127.0.0.1
  smtpPort?: number;   // default: 1025
  imapPort?: number;   // default: 1143
  security?: string;   // default: STARTTLS
}

export interface TelegramProviderConfig {
  botToken: string;
}

export interface SignalProviderConfig {
  phone: string;
}

export interface SmsProviderConfig {
  device: string;
  cli?: string;   // default: kdeconnect-cli
}

export interface WhatsAppProviderConfig {
  authDir?: string;
  phone?: string;
  idleTimeoutMin?: number;
}

// ---------------------------------------------------------------------------
// Proton Bridge defaults
// ---------------------------------------------------------------------------

export const EMAIL_DEFAULTS = {
  host: "127.0.0.1",
  smtpPort: 1025,
  imapPort: 1143,
  security: "STARTTLS",
} as const;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), ".config", "onemessage");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

let cached: OneMessageConfig | null = null;

export function loadConfig(): OneMessageConfig {
  if (cached) return cached;
  if (!existsSync(CONFIG_PATH)) {
    cached = {};
    return cached;
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    cached = JSON.parse(raw) as OneMessageConfig;
    return cached;
  } catch (err: any) {
    process.stderr.write(
      `[config] Warning: could not parse ${CONFIG_PATH}: ${err.message}\n`
    );
    cached = {};
    return cached;
  }
}

export function saveConfig(config: OneMessageConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
  cached = config;
}
