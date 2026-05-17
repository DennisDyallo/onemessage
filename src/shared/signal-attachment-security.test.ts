import { describe, expect, it } from "bun:test";
import path from "node:path";
import {
  constructSafeSignalAttachmentPath,
  isValidSignalAttachmentId,
} from "./signal-attachment-security";

describe("isValidSignalAttachmentId", () => {
  it("should accept valid alphanumeric IDs", () => {
    expect(isValidSignalAttachmentId("abc123")).toBe(true);
    expect(isValidSignalAttachmentId("ABC123")).toBe(true);
    expect(isValidSignalAttachmentId("a1b2c3")).toBe(true);
  });

  it("should accept IDs with hyphens and underscores", () => {
    expect(isValidSignalAttachmentId("abc-123")).toBe(true);
    expect(isValidSignalAttachmentId("abc_123")).toBe(true);
    expect(isValidSignalAttachmentId("abc-def_123")).toBe(true);
  });

  it("should accept base64-like IDs with padding", () => {
    expect(isValidSignalAttachmentId("abc123==")).toBe(true);
    expect(isValidSignalAttachmentId("abc123=")).toBe(true);
  });

  it("should reject path traversal attempts with ..", () => {
    expect(isValidSignalAttachmentId("../foo")).toBe(false);
    expect(isValidSignalAttachmentId("../../etc/passwd")).toBe(false);
    expect(isValidSignalAttachmentId("foo/../bar")).toBe(false);
  });

  it("should reject absolute paths", () => {
    expect(isValidSignalAttachmentId("/etc/passwd")).toBe(false);
    expect(isValidSignalAttachmentId("/tmp/foo")).toBe(false);
  });

  it("should reject IDs with path separators", () => {
    expect(isValidSignalAttachmentId("foo/bar")).toBe(false);
    expect(isValidSignalAttachmentId("foo\\bar")).toBe(false);
  });

  it("should reject IDs with null bytes", () => {
    expect(isValidSignalAttachmentId("foo\x00bar")).toBe(false);
  });

  it("should reject empty strings", () => {
    expect(isValidSignalAttachmentId("")).toBe(false);
  });

  it("should reject undefined and null", () => {
    expect(isValidSignalAttachmentId(undefined)).toBe(false);
    expect(isValidSignalAttachmentId(null as unknown as string)).toBe(false);
  });

  it("should reject very long IDs (>256 chars)", () => {
    const longId = "a".repeat(257);
    expect(isValidSignalAttachmentId(longId)).toBe(false);
  });

  it("should accept reasonably long IDs (<=256 chars)", () => {
    const okId = "a".repeat(256);
    expect(isValidSignalAttachmentId(okId)).toBe(true);
  });

  it("should reject IDs with dots (prevents .. traversal)", () => {
    expect(isValidSignalAttachmentId(".")).toBe(false);
    expect(isValidSignalAttachmentId("..")).toBe(false);
    expect(isValidSignalAttachmentId("foo.bar")).toBe(false);
  });
});

describe("constructSafeSignalAttachmentPath", () => {
  const baseDir = "/tmp/signal-attachments";

  it("should construct path for valid ID", () => {
    const result = constructSafeSignalAttachmentPath(baseDir, "abc123");
    expect(result).not.toBeNull();
    expect(result).toContain("abc123");
    expect(result).toStartWith(baseDir);
  });

  it("should return null for invalid ID (path traversal)", () => {
    expect(constructSafeSignalAttachmentPath(baseDir, "../foo")).toBeNull();
    expect(constructSafeSignalAttachmentPath(baseDir, "../../etc/passwd")).toBeNull();
  });

  it("should return null for absolute path ID", () => {
    expect(constructSafeSignalAttachmentPath(baseDir, "/etc/passwd")).toBeNull();
  });

  it("should return null for empty ID", () => {
    expect(constructSafeSignalAttachmentPath(baseDir, "")).toBeNull();
  });

  it("should return null for undefined ID", () => {
    expect(constructSafeSignalAttachmentPath(baseDir, undefined)).toBeNull();
  });

  it("should ensure resolved path stays within base directory", () => {
    // Even if ID validation passes, the resolved path must be within baseDir
    const result = constructSafeSignalAttachmentPath(baseDir, "abc123");
    expect(result).not.toBeNull();
    if (result) {
      const resolved = path.resolve(result);
      const resolvedBase = path.resolve(baseDir);
      expect(resolved.startsWith(resolvedBase)).toBe(true);
    }
  });

  it("should reject IDs with path separators even if other checks pass", () => {
    // This should fail at the validation step
    expect(constructSafeSignalAttachmentPath(baseDir, "foo/bar")).toBeNull();
  });
});
