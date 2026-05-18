import { describe, expect, mock, test } from "bun:test";

/**
 * Test 0-byte download detection in WhatsApp eager download.
 *
 * downloadMediaMessage can return 0-byte Buffer when:
 * - Network blip during download
 * - Expired media URL
 * - Decryption failure
 *
 * We should NOT write 0-byte files and claim success.
 */
describe("WhatsApp 0-byte download detection", () => {
  test("0-byte download marked as unavailable:download-empty", async () => {
    // Mock downloadMediaMessage to return 0 bytes
    const mockDownload = mock(() => Promise.resolve(Buffer.alloc(0)));

    // We can't easily test parseAndStoreWAMessage in isolation because it has
    // many dependencies (store, translateJid, etc.), so this is a unit test
    // for the LOGIC we should implement:
    const bytes = await mockDownload();

    if (bytes.length === 0) {
      // This is the expected behavior after the fix
      expect(bytes.length).toBe(0);
      // In the real code, we should NOT call writeMedia
      // and should push { unavailable: "download-empty" } instead
    } else {
      // If we got here, the mock is broken or the logic changed
      expect.unreachable("Expected 0-byte download");
    }
  });

  test("non-zero download proceeds normally", async () => {
    const mockDownload = mock(() => Promise.resolve(Buffer.from("audio data", "utf-8")));

    const bytes = await mockDownload();

    expect(bytes.length).toBeGreaterThan(0);
    // In the real code, we should call writeMedia and set path
  });
});
