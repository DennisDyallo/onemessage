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

describe("constructSafeSignalAttachmentPath (charset validation only)", () => {
  const baseDir = "/tmp/signal-attachments";

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

  it("should reject IDs with path separators", () => {
    expect(constructSafeSignalAttachmentPath(baseDir, "foo/bar")).toBeNull();
  });

  it("should return null for valid ID when directory/file doesn't exist", () => {
    // Valid charset but no matching file on disk
    const result = constructSafeSignalAttachmentPath("/nonexistent/dir", "abc123");
    expect(result).toBeNull();
  });
});

import * as fs from "node:fs";
import * as os from "node:os";

describe("constructSafeSignalAttachmentPath with real file resolution", () => {
  it("should resolve <id>.<ext> when file exists", () => {
    // Create a temp directory
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-test-"));

    try {
      // Create a file with extension
      const testFile = path.join(tmpDir, "testid123.aac");
      fs.writeFileSync(testFile, "dummy content");

      // Should find and return the file
      const result = constructSafeSignalAttachmentPath(tmpDir, "testid123");
      expect(result).not.toBeNull();
      expect(result).toBe(path.resolve(testFile));
    } finally {
      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should return null when no matching file exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-test-"));

    try {
      // Empty directory
      const result = constructSafeSignalAttachmentPath(tmpDir, "nonexistent");
      expect(result).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should return null when multiple files match (ambiguous)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-test-"));

    try {
      // Create two files with same ID but different extensions
      fs.writeFileSync(path.join(tmpDir, "ambiguous.aac"), "audio");
      fs.writeFileSync(path.join(tmpDir, "ambiguous.m4a"), "audio2");

      const result = constructSafeSignalAttachmentPath(tmpDir, "ambiguous");
      expect(result).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should not access filesystem for malicious IDs (charset check first)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-test-"));

    try {
      // Create a file that would be vulnerable to traversal
      fs.writeFileSync(path.join(tmpDir, "foo.txt"), "content");

      // Malicious ID should be rejected without filesystem access
      const result = constructSafeSignalAttachmentPath(tmpDir, "../foo");
      expect(result).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should handle bare-id files (no extension) as not found", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-test-"));

    try {
      // Create a file without extension
      fs.writeFileSync(path.join(tmpDir, "bareid"), "content");

      // Should NOT match (spec says signal-cli always writes with extension)
      const result = constructSafeSignalAttachmentPath(tmpDir, "bareid");
      expect(result).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
