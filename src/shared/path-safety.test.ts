import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWithinDir, isSafeFilesystemId } from "./path-safety";

describe("isSafeFilesystemId", () => {
  describe("accepts valid IDs", () => {
    it("accepts alphanumeric IDs", () => {
      expect(isSafeFilesystemId("abc123")).toBe(true);
      expect(isSafeFilesystemId("ABC123")).toBe(true);
      expect(isSafeFilesystemId("a1b2c3")).toBe(true);
    });

    it("accepts IDs with hyphens and underscores", () => {
      expect(isSafeFilesystemId("abc-123")).toBe(true);
      expect(isSafeFilesystemId("abc_123")).toBe(true);
      expect(isSafeFilesystemId("abc-def_123")).toBe(true);
    });

    it("accepts IDs at max length boundary (256 chars)", () => {
      const maxLengthId = "a".repeat(256);
      expect(isSafeFilesystemId(maxLengthId)).toBe(true);
    });
  });

  describe("rejects invalid IDs", () => {
    it("rejects empty string", () => {
      expect(isSafeFilesystemId("")).toBe(false);
    });

    it("rejects undefined and null", () => {
      expect(isSafeFilesystemId(undefined)).toBe(false);
      expect(isSafeFilesystemId(null as unknown as string)).toBe(false);
    });

    it("rejects overly long IDs (>256 chars)", () => {
      const longId = "a".repeat(257);
      expect(isSafeFilesystemId(longId)).toBe(false);
    });

    it("rejects dots (prevents .. traversal)", () => {
      expect(isSafeFilesystemId(".")).toBe(false);
      expect(isSafeFilesystemId("..")).toBe(false);
      expect(isSafeFilesystemId("foo.bar")).toBe(false);
    });

    it("rejects path separators", () => {
      expect(isSafeFilesystemId("foo/bar")).toBe(false);
      expect(isSafeFilesystemId("foo\\bar")).toBe(false);
      expect(isSafeFilesystemId("/etc/passwd")).toBe(false);
    });

    it("rejects null bytes", () => {
      expect(isSafeFilesystemId("foo\x00bar")).toBe(false);
    });
  });

  describe("base64 padding option", () => {
    it("accepts trailing = or == when allowBase64Padding is true", () => {
      expect(isSafeFilesystemId("abc123=", { allowBase64Padding: true })).toBe(true);
      expect(isSafeFilesystemId("abc123==", { allowBase64Padding: true })).toBe(true);
      expect(isSafeFilesystemId("abc-def_123=", { allowBase64Padding: true })).toBe(true);
    });

    it("rejects trailing = when allowBase64Padding is false (default)", () => {
      expect(isSafeFilesystemId("abc123=")).toBe(false);
      expect(isSafeFilesystemId("abc123==")).toBe(false);
    });

    it("rejects = in middle of string even with allowBase64Padding", () => {
      expect(isSafeFilesystemId("abc=123", { allowBase64Padding: true })).toBe(false);
    });
  });
});

describe("ensureWithinDir", () => {
  it("accepts candidate path inside base directory", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "path-test-"));

    try {
      const subDir = join(tmpDir, "subdir");
      mkdirSync(subDir);
      const candidate = join(subDir, "file.txt");

      expect(ensureWithinDir(candidate, tmpDir)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts candidate path equal to base directory", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "path-test-"));

    try {
      expect(ensureWithinDir(tmpDir, tmpDir)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects ../../../etc/passwd style escape", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "path-test-"));

    try {
      const malicious = join(tmpDir, "../../../etc/passwd");
      expect(ensureWithinDir(malicious, tmpDir)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects absolute path outside base", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "path-test-"));

    try {
      expect(ensureWithinDir("/etc/passwd", tmpDir)).toBe(false);
      expect(ensureWithinDir("/tmp/other", tmpDir)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles relative paths correctly", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "path-test-"));

    try {
      const subDir = join(tmpDir, "sub");
      mkdirSync(subDir);

      // Relative path that resolves within base
      const candidate = join(subDir, "../sub/file.txt");
      expect(ensureWithinDir(candidate, tmpDir)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects path that escapes via symlink traversal conceptually", () => {
    // Even without creating actual symlinks, test the logic:
    // If a path resolves to something outside base, it's rejected
    const tmpDir = mkdtempSync(join(tmpdir(), "path-test-"));

    try {
      // Construct a path that would escape if symlinks existed
      const escapeAttempt = join(tmpDir, "subdir", "..", "..", "etc", "passwd");
      const shouldReject = !ensureWithinDir(escapeAttempt, tmpDir);
      expect(shouldReject).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
