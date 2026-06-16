import { describe, expect, test } from "bun:test";
import { resolveServername } from "../../providers/email.ts";

// resolveServername guards against imapflow deriving a boolean `servername`
// for IP hosts (which newer Node rejects at STARTTLS with
// "servername argument must be a string"). See providers/email.ts.
describe("resolveServername", () => {
  test("maps an IPv4 host to localhost", () => {
    expect(resolveServername("127.0.0.1")).toBe("localhost");
  });

  test("maps an IPv6 host to localhost", () => {
    expect(resolveServername("::1")).toBe("localhost");
  });

  test("passes a real hostname through unchanged", () => {
    expect(resolveServername("mail.example.com")).toBe("mail.example.com");
  });

  test("an explicit override always wins, even for an IP host", () => {
    expect(resolveServername("127.0.0.1", "imap.proton.me")).toBe("imap.proton.me");
  });

  test("an empty override is ignored (falls back to host logic)", () => {
    expect(resolveServername("127.0.0.1", "")).toBe("localhost");
    expect(resolveServername("mail.example.com", "")).toBe("mail.example.com");
  });
});
