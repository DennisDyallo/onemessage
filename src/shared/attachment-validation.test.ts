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

  it("should throw when both data and path are set", () => {
    const att: Attachment = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
      data: "base64data",
      path: "/path/to/file.pdf",
    };
    expect(() => validateAttachment(att, { attachmentsRequested: true })).toThrow(
      /both data and path are set/i,
    );
  });

  it("should throw when neither data nor path is set and attachmentsRequested is true", () => {
    const att: Attachment = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
    };
    expect(() => validateAttachment(att, { attachmentsRequested: true })).toThrow(
      /neither data nor path is set/i,
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

  it("should succeed when neither data nor path is set and attachmentsRequested is false", () => {
    const att: Attachment = {
      filename: "test.pdf",
      contentType: "application/pdf",
      size: 1024,
    };
    expect(() => validateAttachment(att, { attachmentsRequested: false })).not.toThrow();
  });
});
