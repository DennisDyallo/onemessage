/**
 * Pure decision logic for WhatsApp audio attachment download.
 *
 * This module contains NO Baileys dependencies and makes NO network calls.
 * It purely decides whether to download an audio attachment based on:
 * - Whether this is a history sync (don't download historical messages)
 * - File size cap (10 MB)
 *
 * Extracted to enable real unit testing without mocking Baileys or network.
 */

export type AudioAttachmentDecision =
  | { action: "download" }
  | { action: "skip"; reason: "history-sync-skipped" | "size-exceeded" };

export interface AudioAttachmentOptions {
  /** File size in bytes (from audioMessage.fileLength) */
  fileLength: number;
  /** Is this message from a history sync? (don't download if true) */
  isHistorySync: boolean;
  /** Size cap in bytes (default 10 MB) */
  sizeCap?: number;
}

const DEFAULT_SIZE_CAP = 10 * 1024 * 1024; // 10 MB

/**
 * Decide whether to download an audio attachment based on gating rules.
 *
 * This is a pure function with NO side effects - suitable for unit testing.
 *
 * @param opts - Audio attachment metadata and context
 * @returns Decision: either download or skip with reason code
 */
export function decideAudioAttachment(opts: AudioAttachmentOptions): AudioAttachmentDecision {
  const { fileLength, isHistorySync, sizeCap = DEFAULT_SIZE_CAP } = opts;

  // Gate 1: History sync - don't download historical messages (prevents flood on restart)
  if (isHistorySync) {
    return { action: "skip", reason: "history-sync-skipped" };
  }

  // Gate 2: Size cap - don't download files larger than limit
  if (fileLength > sizeCap) {
    return { action: "skip", reason: "size-exceeded" };
  }

  // All gates passed - proceed with download
  return { action: "download" };
}
