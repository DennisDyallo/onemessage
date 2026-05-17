import os from "node:os";
import path from "node:path";

/**
 * Get the Signal attachment directory path.
 *
 * signal-cli uses XDG conventions on ALL platforms (including macOS).
 * It does NOT follow Apple's "Library/Application Support" convention.
 *
 * Path resolution:
 *   - If XDG_DATA_HOME is set: $XDG_DATA_HOME/signal-cli/attachments
 *   - Otherwise: ~/.local/share/signal-cli/attachments
 *
 * @returns Absolute path to the signal-cli attachments directory
 */
export function getSignalAttachmentDir(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME;

  if (xdgDataHome) {
    return path.join(xdgDataHome, "signal-cli/attachments");
  }

  const home = os.homedir();
  return path.join(home, ".local/share/signal-cli/attachments");
}
