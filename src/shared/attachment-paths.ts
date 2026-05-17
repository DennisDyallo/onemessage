import os from "node:os";
import path from "node:path";

/**
 * Get the Signal attachment directory path (OS-aware).
 *
 * signal-cli stores attachments in a platform-specific location:
 *   - macOS: ~/Library/Application Support/signal-cli/attachments/
 *   - Linux: ~/.local/share/signal-cli/attachments/
 *
 * @returns Absolute path to the signal-cli attachments directory
 */
export function getSignalAttachmentDir(): string {
  const home = os.homedir();

  if (process.platform === "darwin") {
    return path.join(home, "Library/Application Support/signal-cli/attachments");
  }

  // Linux and other platforms
  return path.join(home, ".local/share/signal-cli/attachments");
}
