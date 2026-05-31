import { describe, expect, test } from "bun:test";
import type { proto } from "@whiskeysockets/baileys";
import { getProvider } from "../registry.ts";
import * as store from "../store.ts";
import type { Attachment, MessageFull } from "../types.ts";
import { whatsappSendResultFromDaemon } from "./whatsapp.ts";
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

describe("WhatsApp queued send result", () => {
  test("does not cache queued offline sends as confirmed sent", () => {
    let cacheCalls = 0;
    const result = whatsappSendResultFromDaemon(
      { ok: true, data: { queued: true, queueSize: 2 } },
      "+46700000000",
      "queued body",
      () => {
        cacheCalls++;
      },
    );

    expect(result).toEqual({
      ok: true,
      provider: "whatsapp",
      recipientId: "+46700000000",
      queued: true,
      queueSize: 2,
    });
    expect(cacheCalls).toBe(0);
  });

  test("caches only confirmed daemon sends", () => {
    let cacheCalls = 0;
    const result = whatsappSendResultFromDaemon(
      { ok: true, data: { messageId: "wa-confirmed-1" } },
      "+46700000000",
      "sent body",
      (msg) => {
        cacheCalls++;
        expect(msg.messageId).toBe("wa-confirmed-1");
      },
    );

    expect(result.messageId).toBe("wa-confirmed-1");
    expect(cacheCalls).toBe(1);
  });
});

describe("inbox-light attachment field stripping (denylist behavior)", () => {
  test("should preserve future Attachment fields not in the denylist", async () => {
    // Tests the REAL whatsappProvider.read() inbox-light strip — not a local destructure.
    // Denylist approach must preserve future Attachment fields and strip data/path/unavailable.
    const msgId = `wa-denylist-test-${Date.now()}`;
    const msg: MessageFull = {
      id: msgId,
      provider: "whatsapp",
      from: { name: "Test User", address: "test@s.whatsapp.net" },
      to: [{ name: "me", address: "me" }],
      preview: "test",
      body: "test",
      bodyFormat: "text",
      date: new Date().toISOString(),
      unread: false,
      hasAttachments: true,
      attachments: [
        {
          filename: "test.pdf",
          contentType: "application/pdf",
          size: 1024,
          path: "/tmp/test.pdf",
          __test_future_field: "preserved",
        } as Attachment & { __test_future_field?: string },
      ] as Attachment[],
      direction: "in",
    };
    store.upsertFullMessage(msg);

    const provider = getProvider("whatsapp");
    if (!provider) throw new Error("WhatsApp provider not registered");

    const result = await provider.read(msgId, { includeAttachments: false });
    expect(result).not.toBeNull();
    if (!result) return;

    const att = result.attachments[0] as Attachment & { __test_future_field?: string };
    expect(att.filename).toBe("test.pdf");
    expect(att.contentType).toBe("application/pdf");
    expect(att.size).toBe(1024);
    expect(att.path).toBeUndefined();
    // The whole point: future fields survive without code changes
    expect(att.__test_future_field).toBe("preserved");
  });

  test("inbox-light strips data/path/unavailable via whatsappProvider.read()", async () => {
    const msgId = `wa-strip-test-${Date.now()}`;
    const msg: MessageFull = {
      id: msgId,
      provider: "whatsapp",
      from: { name: "Test User", address: "test@s.whatsapp.net" },
      to: [{ name: "me", address: "me" }],
      preview: "test",
      body: "test",
      bodyFormat: "text",
      date: new Date().toISOString(),
      unread: false,
      hasAttachments: true,
      attachments: [
        {
          filename: "audio.ogg",
          contentType: "audio/ogg",
          size: 2048,
          path: "/tmp/audio.ogg",
        } as Attachment,
      ] as Attachment[],
      direction: "in",
    };
    store.upsertFullMessage(msg);

    const provider = getProvider("whatsapp");
    if (!provider) throw new Error("WhatsApp provider not registered");

    const result = await provider.read(msgId, { includeAttachments: false });
    expect(result).not.toBeNull();
    if (!result) return;

    const att = result.attachments[0] as Attachment;
    expect(att.filename).toBe("audio.ogg");
    expect(att.contentType).toBe("audio/ogg");
    expect(att.size).toBe(2048);
    expect(att.data).toBeUndefined();
    expect(att.path).toBeUndefined();
    expect(att.unavailable).toBeUndefined();
  });
});
