import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runCacheCli(home: string, args: string[]) {
  return Bun.spawnSync(["bun", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("cache CLI", () => {
  test("cache get and set round-trip provider freshness", () => {
    const home = mkdtempSync(join(tmpdir(), "onemessage-cache-cli-"));
    try {
      const before = runCacheCli(home, ["cache", "get", "sms", "--json"]);
      expect(before.exitCode).toBe(0);
      expect(JSON.parse(before.stdout.toString())[0].freshnessMs).toBe(30_000);

      const set = runCacheCli(home, ["cache", "set", "sms", "5m"]);
      expect(set.exitCode).toBe(0);
      expect(set.stdout.toString()).toContain("sms cache freshness set to 5m");

      const after = runCacheCli(home, ["cache", "get", "sms", "--json"]);
      expect(after.exitCode).toBe(0);
      const parsed = JSON.parse(after.stdout.toString())[0];
      expect(parsed.freshnessMs).toBe(5 * 60_000);
      expect(parsed.configured).toBe("5m");

      const tooLow = runCacheCli(home, ["cache", "set", "instagram", "30s"]);
      expect(tooLow.exitCode).toBe(1);
      expect(tooLow.stderr.toString()).toContain("instagram cache freshness must be at least 2h");

      const unset = runCacheCli(home, ["cache", "unset", "sms"]);
      expect(unset.exitCode).toBe(0);
      expect(unset.stdout.toString()).toContain("sms cache freshness reset to default 30s");

      const reset = runCacheCli(home, ["cache", "get", "sms", "--json"]);
      expect(reset.exitCode).toBe(0);
      expect(JSON.parse(reset.stdout.toString())[0].freshnessMs).toBe(30_000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
