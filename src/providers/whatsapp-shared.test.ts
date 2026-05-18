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
