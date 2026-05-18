import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Write media bytes into the per-provider media tree.
 *
 * Layout: <base>/<provider>/media/<YYYY-MM>/<msgId>.<ext>
 *
 * Creates directories as needed. Overwrites existing files (idempotent).
 *
 * @param provider Provider name (e.g., "whatsapp", "signal")
 * @param msgId Message ID (used as filename base)
 * @param ext File extension (e.g., "ogg", "m4a")
 * @param bytes Media bytes to write
 * @param baseDir Base directory for media storage (defaults to provider-specific default)
 * @returns Absolute path to the written file
 */
export async function writeMedia(
  provider: string,
  msgId: string,
  ext: string,
  bytes: Buffer,
  baseDir?: string,
): Promise<string> {
  // Determine base directory
  const base = baseDir ?? getProviderDefaultBase(provider);

  // Create monthly subfolder (YYYY-MM format)
  const date = new Date();
  const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

  const mediaDir = join(base, provider, "media", yearMonth);
  mkdirSync(mediaDir, { recursive: true });

  const filename = `${msgId}.${ext}`;
  const fullPath = join(mediaDir, filename);

  writeFileSync(fullPath, bytes);

  return fullPath;
}

/**
 * Get the default base directory for a provider's media storage.
 *
 * This is separated to allow testing with custom base directories
 * while production code uses provider-specific defaults.
 */
function getProviderDefaultBase(provider: string): string {
  // For WhatsApp, use the existing WA_DIR convention
  // We can't import from whatsapp-shared here to avoid circular deps,
  // so we replicate the pattern
  if (provider === "whatsapp") {
    const { getConfigDir } = require("../config.ts");
    return join(getConfigDir(), "whatsapp");
  }

  // For other providers, use a similar pattern
  const { getConfigDir } = require("../config.ts");
  return join(getConfigDir(), provider);
}
