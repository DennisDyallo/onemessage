import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeMedia } from "./media-store";

const TEST_BASE = join(import.meta.dir, ".test-media-store");

beforeEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
  mkdirSync(TEST_BASE, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

describe("writeMedia", () => {
  test("writes bytes to expected path with monthly subfolder", async () => {
    const bytes = Buffer.from("test audio data", "utf-8");
    const msgId = "test-msg-123";
    const ext = "ogg";

    const result = await writeMedia("whatsapp", msgId, ext, bytes, TEST_BASE);

    // Should create monthly subfolder (YYYY-MM format)
    const date = new Date();
    const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const expectedPath = join(TEST_BASE, "whatsapp/media", yearMonth, `${msgId}.${ext}`);

    expect(result).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    const written = readFileSync(expectedPath);
    expect(written.toString("utf-8")).toBe("test audio data");
  });

  test("creates directories recursively", async () => {
    const bytes = Buffer.from("data", "utf-8");
    const result = await writeMedia("signal", "msg-456", "m4a", bytes, TEST_BASE);

    expect(existsSync(result)).toBe(true);
  });

  test("overwrites existing file (idempotent)", async () => {
    const msgId = "same-id";
    const ext = "ogg";

    // First write
    await writeMedia("whatsapp", msgId, ext, Buffer.from("first", "utf-8"), TEST_BASE);

    // Second write with same ID - should overwrite
    const result = await writeMedia(
      "whatsapp",
      msgId,
      ext,
      Buffer.from("second", "utf-8"),
      TEST_BASE,
    );

    const written = readFileSync(result);
    expect(written.toString("utf-8")).toBe("second");
  });

  test("handles different providers independently", async () => {
    const bytes = Buffer.from("test", "utf-8");
    const msgId = "shared-id";

    const whatsappPath = await writeMedia("whatsapp", msgId, "ogg", bytes, TEST_BASE);
    const signalPath = await writeMedia("signal", msgId, "m4a", bytes, TEST_BASE);

    expect(whatsappPath).toContain("whatsapp/media");
    expect(signalPath).toContain("signal/media");
    expect(whatsappPath).not.toBe(signalPath);

    expect(existsSync(whatsappPath)).toBe(true);
    expect(existsSync(signalPath)).toBe(true);
  });

  describe("path traversal protection", () => {
    test("rejects msgId with .. (parent directory traversal)", async () => {
      const bytes = Buffer.from("malicious", "utf-8");

      await expect(
        writeMedia("whatsapp", "../etc/passwd", "ogg", bytes, TEST_BASE),
      ).rejects.toThrow("Invalid message ID");

      await expect(writeMedia("whatsapp", "../../foo", "ogg", bytes, TEST_BASE)).rejects.toThrow(
        "Invalid message ID",
      );
    });

    test("rejects msgId with absolute path", async () => {
      const bytes = Buffer.from("malicious", "utf-8");

      await expect(writeMedia("whatsapp", "/etc/passwd", "ogg", bytes, TEST_BASE)).rejects.toThrow(
        "Invalid message ID",
      );
    });

    test("rejects msgId with dots", async () => {
      const bytes = Buffer.from("malicious", "utf-8");

      await expect(writeMedia("whatsapp", "foo.bar", "ogg", bytes, TEST_BASE)).rejects.toThrow(
        "Invalid message ID",
      );

      await expect(writeMedia("whatsapp", "..", "ogg", bytes, TEST_BASE)).rejects.toThrow(
        "Invalid message ID",
      );

      await expect(writeMedia("whatsapp", ".", "ogg", bytes, TEST_BASE)).rejects.toThrow(
        "Invalid message ID",
      );
    });

    test("rejects msgId with slashes", async () => {
      const bytes = Buffer.from("malicious", "utf-8");

      await expect(writeMedia("whatsapp", "foo/bar", "ogg", bytes, TEST_BASE)).rejects.toThrow(
        "Invalid message ID",
      );

      await expect(writeMedia("whatsapp", "foo\\bar", "ogg", bytes, TEST_BASE)).rejects.toThrow(
        "Invalid message ID",
      );
    });

    test("rejects empty msgId", async () => {
      const bytes = Buffer.from("test", "utf-8");

      await expect(writeMedia("whatsapp", "", "ogg", bytes, TEST_BASE)).rejects.toThrow(
        "Invalid message ID",
      );
    });

    test("rejects overly long msgId (>256 chars)", async () => {
      const bytes = Buffer.from("test", "utf-8");
      const longId = "a".repeat(257);

      await expect(writeMedia("whatsapp", longId, "ogg", bytes, TEST_BASE)).rejects.toThrow(
        "Invalid message ID",
      );
    });

    test("rejects msgId with whitespace", async () => {
      const bytes = Buffer.from("test", "utf-8");

      await expect(writeMedia("whatsapp", "foo bar", "ogg", bytes, TEST_BASE)).rejects.toThrow(
        "Invalid message ID",
      );
    });

    test("rejects msgId with special characters", async () => {
      const bytes = Buffer.from("test", "utf-8");

      await expect(writeMedia("whatsapp", "foo@bar", "ogg", bytes, TEST_BASE)).rejects.toThrow(
        "Invalid message ID",
      );

      await expect(writeMedia("whatsapp", "foo$bar", "ogg", bytes, TEST_BASE)).rejects.toThrow(
        "Invalid message ID",
      );
    });
  });
});
