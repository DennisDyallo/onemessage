import { describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
import { getSignalAttachmentDir } from "./attachment-paths";

describe("getSignalAttachmentDir", () => {
  const originalEnv = process.env.XDG_DATA_HOME;

  // Clean up after each test
  function cleanup() {
    if (originalEnv === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalEnv;
    }
  }

  it("should return XDG path on macOS (not Apple convention)", () => {
    delete process.env.XDG_DATA_HOME;

    const result = getSignalAttachmentDir();
    const expected = path.join(os.homedir(), ".local/share/signal-cli/attachments");

    expect(result).toBe(expected);
    expect(result).toContain(".local/share/signal-cli/attachments");
    expect(result).not.toContain("Library/Application Support");

    cleanup();
  });

  it("should return XDG path on Linux", () => {
    delete process.env.XDG_DATA_HOME;

    const result = getSignalAttachmentDir();
    const expected = path.join(os.homedir(), ".local/share/signal-cli/attachments");

    expect(result).toBe(expected);
    expect(result).toContain(".local/share/signal-cli/attachments");

    cleanup();
  });

  it("should respect XDG_DATA_HOME env var when set", () => {
    process.env.XDG_DATA_HOME = "/custom/xdg/data";

    const result = getSignalAttachmentDir();
    const expected = "/custom/xdg/data/signal-cli/attachments";

    expect(result).toBe(expected);
    expect(result).toContain("/custom/xdg/data/signal-cli/attachments");

    cleanup();
  });

  it("should fall back to default when XDG_DATA_HOME is empty string", () => {
    process.env.XDG_DATA_HOME = "";

    const result = getSignalAttachmentDir();
    const expected = path.join(os.homedir(), ".local/share/signal-cli/attachments");

    expect(result).toBe(expected);

    cleanup();
  });
});
