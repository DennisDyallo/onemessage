import { describe, expect, test } from "bun:test";
import { isValidMediaId } from "./media-id-validation";

describe("isValidMediaId", () => {
  test("accepts valid alphanumeric IDs", () => {
    expect(isValidMediaId("3EB0F8E9D7F5A1C2B0E3")).toBe(true);
    expect(isValidMediaId("abc123")).toBe(true);
    expect(isValidMediaId("MSG-2024-05-18")).toBe(true);
    expect(isValidMediaId("wa_12345")).toBe(true);
  });

  test("accepts IDs with hyphens and underscores", () => {
    expect(isValidMediaId("msg-with-hyphens")).toBe(true);
    expect(isValidMediaId("msg_with_underscores")).toBe(true);
    expect(isValidMediaId("msg-123_ABC")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidMediaId("")).toBe(false);
  });

  test("rejects undefined", () => {
    expect(isValidMediaId(undefined)).toBe(false);
  });

  test("rejects null", () => {
    expect(isValidMediaId(null as unknown as string)).toBe(false);
  });

  test("rejects non-string types", () => {
    expect(isValidMediaId(123 as unknown as string)).toBe(false);
    expect(isValidMediaId({} as unknown as string)).toBe(false);
  });

  test("rejects path traversal attempts with ..", () => {
    expect(isValidMediaId("../etc/passwd")).toBe(false);
    expect(isValidMediaId("../../foo")).toBe(false);
    expect(isValidMediaId("foo/../bar")).toBe(false);
  });

  test("rejects absolute paths", () => {
    expect(isValidMediaId("/etc/passwd")).toBe(false);
    expect(isValidMediaId("/tmp/foo")).toBe(false);
  });

  test("rejects paths with dots", () => {
    expect(isValidMediaId("foo.bar")).toBe(false);
    expect(isValidMediaId("msg.id")).toBe(false);
    // Double-dots are especially dangerous
    expect(isValidMediaId("..")).toBe(false);
    expect(isValidMediaId(".")).toBe(false);
  });

  test("rejects paths with slashes", () => {
    expect(isValidMediaId("foo/bar")).toBe(false);
    expect(isValidMediaId("msg\\id")).toBe(false); // Windows path separator
  });

  test("rejects null bytes", () => {
    expect(isValidMediaId("foo\0bar")).toBe(false);
  });

  test("rejects whitespace", () => {
    expect(isValidMediaId("foo bar")).toBe(false);
    expect(isValidMediaId("msg\tid")).toBe(false);
    expect(isValidMediaId("msg\nid")).toBe(false);
  });

  test("rejects overly long IDs", () => {
    const longId = "a".repeat(257);
    expect(isValidMediaId(longId)).toBe(false);
  });

  test("accepts IDs at max length boundary", () => {
    const maxLengthId = "a".repeat(256);
    expect(isValidMediaId(maxLengthId)).toBe(true);
  });

  test("rejects special characters", () => {
    expect(isValidMediaId("msg@id")).toBe(false);
    expect(isValidMediaId("msg#id")).toBe(false);
    expect(isValidMediaId("msg$id")).toBe(false);
    expect(isValidMediaId("msg%id")).toBe(false);
  });
});
