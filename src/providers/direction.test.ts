import { describe, test, expect } from "bun:test";

// Test the isOutgoingEmail pattern
describe("email direction detection", () => {
  const stripTag = (addr: string) => addr.replace(/\+[^@]*@/, "@").toLowerCase();

  function isOutgoing(fromAddr: string | undefined, ownAccounts: string[]): boolean {
    if (!fromAddr) return false;
    return ownAccounts.some(own => stripTag(own) === stripTag(fromAddr));
  }

  test("matches exact account address", () => {
    expect(isOutgoing("user@proton.me", ["user@proton.me"])).toBe(true);
  });

  test("matches case-insensitively", () => {
    expect(isOutgoing("User@Proton.me", ["user@proton.me"])).toBe(true);
  });

  test("matches with +suffix tag", () => {
    expect(isOutgoing("user+services@proton.me", ["user@proton.me"])).toBe(true);
  });

  test("does not match different address", () => {
    expect(isOutgoing("other@gmail.com", ["user@proton.me"])).toBe(false);
  });

  test("handles undefined from address", () => {
    expect(isOutgoing(undefined, ["user@proton.me"])).toBe(false);
  });

  test("matches secondary accounts", () => {
    expect(isOutgoing("alias@pm.me", ["primary@proton.me", "alias@pm.me"])).toBe(true);
  });
});
