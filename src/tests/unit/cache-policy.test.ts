import { describe, expect, test } from "bun:test";
import { getDefaultProviderFreshnessMs, resolveProviderFreshnessMs } from "../../config.ts";

describe("provider cache policy defaults", () => {
  test("instagram defaults to two hours", () => {
    expect(getDefaultProviderFreshnessMs("instagram")).toBe(2 * 60 * 60_000);
  });

  test("other providers default to thirty seconds", () => {
    for (const provider of ["email", "signal", "sms", "telegram-bot", "whatsapp", "matrix"]) {
      expect(getDefaultProviderFreshnessMs(provider)).toBe(30_000);
      expect(resolveProviderFreshnessMs(provider, {})).toBe(30_000);
    }
  });

  test("provider config overrides defaults", () => {
    expect(
      resolveProviderFreshnessMs("sms", {
        cache: { providers: { sms: { freshnessMs: 10 * 60_000 } } },
      }),
    ).toBe(10 * 60_000);
  });

  test("invalid provider config falls back to defaults", () => {
    expect(
      resolveProviderFreshnessMs("instagram", {
        cache: { providers: { instagram: { freshnessMs: 0 } } },
      }),
    ).toBe(2 * 60 * 60_000);
  });
});
