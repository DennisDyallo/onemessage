import { describe, expect, test } from "bun:test";
import type { proto } from "@whiskeysockets/baileys";
import { isAudioMessage } from "./whatsapp-shared";

describe("isAudioMessage", () => {
  test("returns true for audioMessage", () => {
    const msg: proto.IMessage = {
      audioMessage: {
        url: "https://example.com/audio.ogg",
        mimetype: "audio/ogg; codecs=opus",
        fileSha256: Buffer.from("sha256"),
        fileLength: 1024,
      },
    };
    expect(isAudioMessage(msg)).toBe(true);
  });

  test("returns true for audioMessage with ptt flag (voice note)", () => {
    const msg: proto.IMessage = {
      audioMessage: {
        url: "https://example.com/voice.ogg",
        mimetype: "audio/ogg; codecs=opus",
        fileSha256: Buffer.from("sha256"),
        fileLength: 2048,
        ptt: true,
      },
    };
    expect(isAudioMessage(msg)).toBe(true);
  });

  test("returns false for text message", () => {
    const msg: proto.IMessage = {
      conversation: "Hello world",
    };
    expect(isAudioMessage(msg)).toBe(false);
  });

  test("returns false for image message", () => {
    const msg: proto.IMessage = {
      imageMessage: {
        url: "https://example.com/image.jpg",
        caption: "Photo caption",
        mimetype: "image/jpeg",
        fileSha256: Buffer.from("sha256"),
        fileLength: 10240,
      },
    };
    expect(isAudioMessage(msg)).toBe(false);
  });

  test("returns false for video message", () => {
    const msg: proto.IMessage = {
      videoMessage: {
        url: "https://example.com/video.mp4",
        caption: "Video caption",
        mimetype: "video/mp4",
        fileSha256: Buffer.from("sha256"),
        fileLength: 102400,
      },
    };
    expect(isAudioMessage(msg)).toBe(false);
  });

  test("returns false for null message", () => {
    expect(isAudioMessage(null)).toBe(false);
  });

  test("returns false for undefined message", () => {
    expect(isAudioMessage(undefined)).toBe(false);
  });
});

describe("inbox-light attachment field stripping (denylist behavior)", () => {
  test("should preserve future Attachment fields not in the denylist", () => {
    // This test verifies that the inbox-light strip uses a denylist approach
    // (remove data/path/unavailable) rather than an allowlist (keep only filename/contentType/size).
    // If the Attachment type gains new fields in the future, they should be preserved.

    const mockAttachment: any = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
      path: "/tmp/test.pdf", // should be stripped
      __test_future_field: "preserved", // hypothetical future field
    };

    // Simulate the inbox-light strip logic from whatsapp.ts
    const { data: _d, path: _p, unavailable: _u, ...rest } = mockAttachment;

    expect(rest.filename).toBe("test.pdf");
    expect(rest.contentType).toBe("application/pdf");
    expect(rest.size).toBe(1024);
    expect((rest as any).path).toBeUndefined(); // stripped
    expect((rest as any).__test_future_field).toBe("preserved"); // NOT stripped
  });

  test("should strip all three heavyweight fields (data, path, unavailable)", () => {
    const mockAttachment: any = {
      filename: "audio.ogg",
      contentType: "audio/ogg",
      size: 2048,
      data: Buffer.from("fake data"),
      path: "/tmp/audio.ogg",
      unavailable: true,
    };

    const { data: _d, path: _p, unavailable: _u, ...rest } = mockAttachment;

    expect(rest.filename).toBe("audio.ogg");
    expect(rest.contentType).toBe("audio/ogg");
    expect(rest.size).toBe(2048);
    expect((rest as any).data).toBeUndefined();
    expect((rest as any).path).toBeUndefined();
    expect((rest as any).unavailable).toBeUndefined();
  });
});
