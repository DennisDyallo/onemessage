import { describe, expect, it } from "bun:test";
import type { Attachment } from "../types";
import { validateAttachment } from "./attachment-validation";

describe("validateAttachment", () => {
  it("should succeed when data is set and attachmentsRequested is true", () => {
    const att: Attachment = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
      data: "base64data",
    };
    expect(() => validateAttachment(att, { attachmentsRequested: true })).not.toThrow();
  });

  it("should succeed when path is set and attachmentsRequested is true", () => {
    const att: Attachment = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
      path: "/path/to/file.pdf",
    };
    expect(() => validateAttachment(att, { attachmentsRequested: true })).not.toThrow();
  });

  it("should succeed when unavailable is set and attachmentsRequested is true", () => {
    const att: Attachment = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
      unavailable: "no-id",
    };
    expect(() => validateAttachment(att, { attachmentsRequested: true })).not.toThrow();
  });

  it("should throw when multiple fields are set (data + path)", () => {
    const att: Attachment = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
      data: "base64data",
      path: "/path/to/file.pdf",
    };
    expect(() => validateAttachment(att, { attachmentsRequested: true })).toThrow(
      /multiple fields set/i,
    );
  });

  it("should throw when multiple fields are set (data + unavailable)", () => {
    const att: Attachment = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
      data: "base64data",
      unavailable: "no-id",
    };
    expect(() => validateAttachment(att, { attachmentsRequested: true })).toThrow(
      /multiple fields set/i,
    );
  });

  it("should throw when multiple fields are set (path + unavailable)", () => {
    const att: Attachment = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
      path: "/path/to/file.pdf",
      unavailable: "no-id",
    };
    expect(() => validateAttachment(att, { attachmentsRequested: true })).toThrow(
      /multiple fields set/i,
    );
  });

  it("should throw when all three fields are set", () => {
    const att: Attachment = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
      data: "base64data",
      path: "/path/to/file.pdf",
      unavailable: "no-id",
    };
    expect(() => validateAttachment(att, { attachmentsRequested: true })).toThrow(
      /multiple fields set/i,
    );
  });

  it("should throw when none of data/path/unavailable is set and attachmentsRequested is true", () => {
    const att: Attachment = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
    };
    expect(() => validateAttachment(att, { attachmentsRequested: true })).toThrow(
      /none of data, path, or unavailable/i,
    );
  });

  it("should throw when data is set but attachmentsRequested is false (inbox-light invariant)", () => {
    const att: Attachment = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
      data: "base64data",
    };
    expect(() => validateAttachment(att, { attachmentsRequested: false })).toThrow(
      /should not be set when attachments were not requested/i,
    );
  });

  it("should throw when path is set but attachmentsRequested is false (inbox-light invariant)", () => {
    const att: Attachment = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
      path: "/path/to/file.pdf",
    };
    expect(() => validateAttachment(att, { attachmentsRequested: false })).toThrow(
      /should not be set when attachments were not requested/i,
    );
  });

  it("should throw when unavailable is set but attachmentsRequested is false (inbox-light invariant)", () => {
    const att: Attachment = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
      unavailable: "no-id",
    };
    expect(() => validateAttachment(att, { attachmentsRequested: false })).toThrow(
      /should not be set when attachments were not requested/i,
    );
  });

  it("should succeed when none of data/path/unavailable is set and attachmentsRequested is false", () => {
    const att: Attachment = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
    };
    expect(() => validateAttachment(att, { attachmentsRequested: false })).not.toThrow();
  });
});
