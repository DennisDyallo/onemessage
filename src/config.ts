import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config shape — flat and slim
// ---------------------------------------------------------------------------

export interface OneMessageConfig {
  senderName?: string;
  me?: MeConfig;
  email?: EmailProviderConfig;
  telegramBot?: TelegramBotProviderConfig;
  instagram?: InstagramProviderConfig;
  signal?: SignalProviderConfig;
  sms?: SmsProviderConfig;
  whatsapp?: WhatsAppProviderConfig;
  matrix?: MatrixProviderConfig;
  daemon?: DaemonConfig;
  cache?: CacheConfig;
}

/** Which provider + address to use for `onemessage me` (send to yourself) */
export interface MeConfig {
  /** Registered provider name, e.g. "telegram-bot", "signal", "email" */
  provider: string;
  /** Your address on that provider — chat_id, phone number, email address */
  recipientId: string;
}

export interface DaemonConfig {
  pollIntervalMs?: number;
  providers?: {
    whatsapp?: { enabled?: boolean };
    signal?: { enabled?: boolean; pollIntervalMs?: number };
    email?: { enabled?: boolean; pollIntervalMs?: number };
    sms?: { enabled?: boolean; pollIntervalMs?: number };
    "telegram-bot"?: { enabled?: boolean; pollIntervalMs?: number };
    instagram?: { enabled?: boolean; pollIntervalMs?: number };
    matrix?: { enabled?: boolean; pollIntervalMs?: number };
  };
}

export interface CacheConfig {
  providers?: Record<string, { freshnessMs?: number }>;
}

const DEFAULT_PROVIDER_FRESHNESS_MS = 30_000;
// Instagram polling is intentionally conservative because the upstream API is rate-limit sensitive.
const DEFAULT_INSTAGRAM_FRESHNESS_MS = 2 * 60 * 60_000;
const MIN_PROVIDER_FRESHNESS_MS = 1_000;
const MIN_INSTAGRAM_FRESHNESS_MS = DEFAULT_INSTAGRAM_FRESHNESS_MS;

export function getDefaultProviderFreshnessMs(provider: string): number {
  return provider === "instagram" ? DEFAULT_INSTAGRAM_FRESHNESS_MS : DEFAULT_PROVIDER_FRESHNESS_MS;
}

export function getMinimumProviderFreshnessMs(provider: string): number {
  return provider === "instagram" ? MIN_INSTAGRAM_FRESHNESS_MS : MIN_PROVIDER_FRESHNESS_MS;
}

export function isValidFreshnessMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isUsableProviderFreshnessMs(provider: string, value: unknown): value is number {
  return isValidFreshnessMs(value) && value >= getMinimumProviderFreshnessMs(provider);
}

export function resolveProviderFreshnessMs(provider: string, config: OneMessageConfig): number {
  const configured = config.cache?.providers?.[provider]?.freshnessMs;
  return isUsableProviderFreshnessMs(provider, configured)
    ? configured
    : getDefaultProviderFreshnessMs(provider);
}

export function getProviderFreshnessMs(provider: string): number {
  return resolveProviderFreshnessMs(provider, loadConfig());
}

export function parseDurationMs(value: string): number | null {
  const match = value.trim().match(/^(\d+)(ms|s|m|h)?$/i);
  if (!match?.[1]) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = match[2]?.toLowerCase() ?? "ms";
  const multiplier = unit === "h" ? 60 * 60_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
  const ms = Math.round(amount * multiplier);
  return ms > 0 ? ms : null;
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return `${ms}ms`;
  if (ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

export interface EmailProviderConfig {
  password: string;
  accounts: string[];
  default?: string;
  // Accounts whose messages are hidden from default inbox (shown with --all)
  secondaryAccounts?: string[];
  // Default IMAP mailbox to fetch from. Use "All Mail" for Proton Mail setups
  // that use filters/labels (Proton routes filtered mail out of INBOX).
  // Defaults to "INBOX" for standard IMAP compatibility.
  defaultFolder?: string;
  // Overrides — only needed if not using standard Proton Bridge
  host?: string; // default: 127.0.0.1
  smtpPort?: number; // default: 1025
  imapPort?: number; // default: 1143
  security?: string; // default: STARTTLS
}

export interface TelegramBotProviderConfig {
  botToken: string;
}

export interface InstagramProviderConfig {
  username: string;
}

export interface SignalProviderConfig {
  phone: string;
}

export interface SmsProviderConfig {
  device: string;
  cli?: string; // default: kdeconnect-cli
}

export interface WhatsAppProviderConfig {
  authDir?: string;
  phone?: string;
  idleTimeoutMin?: number;
}

export interface MatrixProviderConfig {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId?: string;
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[config] Warning: could not parse ${CONFIG_PATH}: ${message}\n`);
    cached = {};
    return cached;
  }
}

export function saveConfig(config: OneMessageConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  cached = config;
}
