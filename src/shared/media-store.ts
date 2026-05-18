import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getConfigDir } from "../config.ts";
import { isValidMediaId } from "./media-id-validation.ts";

/**
 * Write media bytes into the per-provider media tree.
 *
 * Layout: <base>/<provider>/media/<YYYY-MM>/<msgId>.<ext>
 *
 * Creates directories as needed. Overwrites existing files (idempotent).
 *
 * Security: validates msgId against path traversal attacks before filesystem access.
 *
 * @param provider Provider name (e.g., "whatsapp", "signal")
 * @param msgId Message ID (used as filename base) - must be alphanumeric+hyphens/underscores only
 * @param ext File extension (e.g., "ogg", "m4a")
 * @param bytes Media bytes to write
 * @param baseDir Base directory for media storage (defaults to provider-specific default)
 * @returns Absolute path to the written file
 * @throws {Error} If msgId contains path traversal attempts or invalid characters
 */
export async function writeMedia(
  provider: string,
  msgId: string,
  ext: string,
  bytes: Buffer,
  baseDir?: string,
): Promise<string> {
  // Validate msgId against path traversal attacks
  if (!isValidMediaId(msgId)) {
    throw new Error(
      `Invalid message ID "${msgId}": must be alphanumeric with hyphens/underscores only (no dots, slashes, or special characters)`,
    );
  }

  // Determine base directory
  const base = baseDir ?? getProviderDefaultBase(provider);

  // Create monthly subfolder (YYYY-MM format)
  const date = new Date();
  const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

  const mediaDir = join(base, provider, "media", yearMonth);
  mkdirSync(mediaDir, { recursive: true });

  const filename = `${msgId}.${ext}`;
  const fullPath = join(mediaDir, filename);

  // Defensive: verify the resolved path is within mediaDir
  const resolvedPath = resolve(fullPath);
  const resolvedMediaDir = resolve(mediaDir);

  if (!resolvedPath.startsWith(resolvedMediaDir + sep) && resolvedPath !== resolvedMediaDir) {
    throw new Error(
      `Path traversal detected: resolved path "${resolvedPath}" is outside media directory "${resolvedMediaDir}"`,
    );
  }

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
    return join(getConfigDir(), "whatsapp");
  }

  // For other providers, use a similar pattern
  return join(getConfigDir(), provider);
}
