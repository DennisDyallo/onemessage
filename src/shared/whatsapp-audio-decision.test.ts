import { describe, expect, test } from "bun:test";
import { decideAudioAttachment } from "./whatsapp-audio-decision.ts";

/**
 * Tests for WhatsApp audio download decision logic.
 *
 * These are REAL tests of production code (not mocks). The helper is pure -
 * no Baileys deps, no network calls, no side effects.
 *
 * Covers:
 * - History sync gate (Plan §1.3, §1.6)
 * - Size cap gate (Plan §1.3)
 * - Happy path (download decision)
 */
describe("decideAudioAttachment", () => {
  const DEFAULT_SIZE_CAP = 10 * 1024 * 1024; // 10 MB

  test("should skip download when isHistorySync=true", () => {
    // Regression test for Finding #3 (missing-test)
    // History sync gate prevents download flood on daemon restart
    const decision = decideAudioAttachment({
      fileLength: 5000,
      isHistorySync: true,
    });

    expect(decision.action).toBe("skip");
    expect(decision.reason).toBe("history-sync-skipped");
  });

  test("should skip download when fileLength exceeds size cap", () => {
    const decision = decideAudioAttachment({
      fileLength: 15 * 1024 * 1024, // 15 MB
      isHistorySync: false,
    });

    expect(decision.action).toBe("skip");
    expect(decision.reason).toBe("size-exceeded");
  });

  test("should download when fileLength equals size cap", () => {
    // Boundary case: exactly at the cap should download
    const decision = decideAudioAttachment({
      fileLength: DEFAULT_SIZE_CAP,
      isHistorySync: false,
    });

    expect(decision.action).toBe("download");
  });

  test("should download when fileLength is just under size cap", () => {
    const decision = decideAudioAttachment({
      fileLength: DEFAULT_SIZE_CAP - 1,
      isHistorySync: false,
    });

    expect(decision.action).toBe("download");
  });

  test("should download when fileLength is 0 bytes (edge case)", () => {
    // 0-byte download detection happens AFTER download, not in decision phase
    const decision = decideAudioAttachment({
      fileLength: 0,
      isHistorySync: false,
    });

    expect(decision.action).toBe("download");
  });

  test("should respect custom sizeCap parameter", () => {
    const customCap = 5 * 1024 * 1024; // 5 MB
    const decision = decideAudioAttachment({
      fileLength: 7 * 1024 * 1024, // 7 MB
      isHistorySync: false,
      sizeCap: customCap,
    });

    expect(decision.action).toBe("skip");
    expect(decision.reason).toBe("size-exceeded");
  });

  test("history sync gate takes precedence over size cap", () => {
    // Even if file is small, history sync prevents download
    const decision = decideAudioAttachment({
      fileLength: 100,
      isHistorySync: true,
    });

    expect(decision.action).toBe("skip");
    expect(decision.reason).toBe("history-sync-skipped");
  });

  test("should skip when BOTH gates apply (history sync + oversized)", () => {
    const decision = decideAudioAttachment({
      fileLength: 20 * 1024 * 1024, // 20 MB
      isHistorySync: true,
    });

    // History sync gate is checked first
    expect(decision.action).toBe("skip");
    expect(decision.reason).toBe("history-sync-skipped");
  });
});
