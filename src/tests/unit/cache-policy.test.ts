import { describe, expect, test } from "bun:test";
import {
  formatDurationMs,
  getDefaultProviderFreshnessMs,
  parseDurationMs,
  resolveProviderFreshnessMs,
} from "../../config.ts";

describe("provider cache policy defaults", () => {
  test("instagram defaults to two hours", () => {
    expect(getDefaultProviderFreshnessMs("instagram")).toBe(2 * 60 * 60_000);
  });

  test("other providers default to thirty seconds", () => {
    for (const provider of [
      "email",
      "signal",
      "sms",
      "telegram-bot",
      "whatsapp",
      "matrix",
      "messenger",
    ]) {
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

  test("below-minimum provider config falls back to defaults", () => {
    expect(
      resolveProviderFreshnessMs("instagram", {
        cache: { providers: { instagram: { freshnessMs: 30_000 } } },
      }),
    ).toBe(2 * 60 * 60_000);
    expect(
      resolveProviderFreshnessMs("sms", {
        cache: { providers: { sms: { freshnessMs: 500 } } },
      }),
    ).toBe(30_000);
  });

  test("duration parser accepts CLI units", () => {
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(5 * 60_000);
    expect(parseDurationMs("2h")).toBe(2 * 60 * 60_000);
    expect(parseDurationMs("30000")).toBe(30_000);
  });

  test("duration parser rejects invalid values", () => {
    expect(parseDurationMs("0s")).toBeNull();
    expect(parseDurationMs("-1s")).toBeNull();
    expect(parseDurationMs("1.5s")).toBeNull();
    expect(parseDurationMs("soon")).toBeNull();
  });

  test("duration formatter uses compact units", () => {
    expect(formatDurationMs(2 * 60 * 60_000)).toBe("2h");
    expect(formatDurationMs(5 * 60_000)).toBe("5m");
    expect(formatDurationMs(30_000)).toBe("30s");
    expect(formatDurationMs(500)).toBe("500ms");
  });
});
