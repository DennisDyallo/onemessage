import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instagramProvider } from "../../providers/instagram.ts";
import { closeDb, getCachedMessage, recordFetch, upsertFullMessages } from "../../store.ts";

const originalConfigDir = process.env.ONEMESSAGE_CONFIG_DIR;
let configDir = "";

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "onemessage-instagram-account-test-"));
  process.env.ONEMESSAGE_CONFIG_DIR = configDir;
  closeDb();
});

afterAll(() => {
  closeDb();
  if (originalConfigDir === undefined) delete process.env.ONEMESSAGE_CONFIG_DIR;
  else process.env.ONEMESSAGE_CONFIG_DIR = originalConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

describe("Instagram cache account isolation", () => {
  test("page JSON excludes cached rows from a stale configured account", () => {
    const username = "fixture-instagram-current";
    const staleUsername = "fixture-instagram-stale";
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ instagram: { username } }),
      "utf-8",
    );
    upsertFullMessages([
      {
        id: "fixture-instagram-page-current",
        provider: "instagram",
        account: username,
        from: { name: "Current Sender", address: "current-sender" },
        to: [{ name: "Current Chat", address: "current-chat" }],
        preview: "current",
        body: "current",
        bodyFormat: "text",
        date: "2026-07-21T09:00:00.000Z",
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in",
      },
      {
        id: "fixture-instagram-page-stale",
        provider: "instagram",
        account: staleUsername,
        from: { name: "Stale Sender", address: "stale-sender" },
        to: [{ name: "Stale Chat", address: "stale-chat" }],
        preview: "stale",
        body: "stale",
        bodyFormat: "text",
        date: "2026-07-21T09:01:00.000Z",
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in",
      },
    ]);
    recordFetch("instagram", username);

    const result = Bun.spawnSync(
      [process.execPath, "src/cli.ts", "inbox", "instagram", "--page-json", "--limit", "10"],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: configDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).toBe(0);
    const page = JSON.parse(result.stdout.toString());
    const ids = page.messages.map((message: { id: string }) => message.id);
    expect(ids).toContain("fixture-instagram-page-current");
    expect(ids).not.toContain("fixture-instagram-page-stale");
  });

  test("provider flag username overrides the configured cache account", () => {
    expect(
      instagramProvider.resolveCacheAccount?.({ username: "fixture-instagram-override" }),
    ).toBe("fixture-instagram-override");
  });

  test("page JSON rejects an explicit account conflicting with configured Instagram", () => {
    const username = "fixture-instagram-conflict-current";
    const staleUsername = "fixture-instagram-conflict-stale";
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ instagram: { username } }),
      "utf-8",
    );
    upsertFullMessages([
      {
        id: "fixture-instagram-conflict-stale-message",
        provider: "instagram",
        account: staleUsername,
        from: { name: "Stale Sender", address: "stale-sender" },
        to: [{ name: "Stale Chat", address: "stale-chat" }],
        preview: "stale",
        body: "stale",
        bodyFormat: "text",
        date: "2026-07-21T09:02:00.000Z",
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in",
      },
    ]);
    recordFetch("instagram", username);

    const result = Bun.spawnSync(
      [
        process.execPath,
        "src/cli.ts",
        "inbox",
        "instagram",
        "--page-json",
        "--account",
        staleUsername,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: configDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("--account conflicts with the configured account");
    expect(result.stdout.toString()).not.toContain("fixture-instagram-conflict-stale-message");
  });

  test("page JSON rejects an unconfigured Instagram account before reading stale cache", () => {
    const staleUsername = "fixture-instagram-unconfigured-stale";
    writeFileSync(join(configDir, "config.json"), JSON.stringify({}), "utf-8");
    upsertFullMessages([
      {
        id: "fixture-instagram-unconfigured-stale-message",
        provider: "instagram",
        account: staleUsername,
        from: { name: "Stale Sender", address: "stale-sender" },
        to: [{ name: "Stale Chat", address: "stale-chat" }],
        preview: "stale",
        body: "stale",
        bodyFormat: "text",
        date: "2026-07-21T09:03:00.000Z",
        unread: false,
        hasAttachments: false,
        attachments: [],
        direction: "in",
      },
    ]);

    const result = Bun.spawnSync(
      [
        process.execPath,
        "src/cli.ts",
        "inbox",
        "instagram",
        "--page-json",
        "--account",
        staleUsername,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: configDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Cannot resolve the configured account");
    expect(result.stdout.toString()).not.toContain("fixture-instagram-unconfigured-stale-message");
  });

  test("send caches the configured Instagram account using a fake CLI", async () => {
    const fakeBinDir = join(configDir, "fake-bin");
    mkdirSync(fakeBinDir, { recursive: true });
    const fakeCli = join(fakeBinDir, "instagram-cli");
    writeFileSync(
      fakeCli,
      `#!/bin/sh
printf '%s\n' '{"ok":true,"data":{"threadId":"fixture-thread","recipient":"fixture-recipient","messageId":"fixture-instagram-sent","sent":true}}'
`,
      "utf-8",
    );
    chmodSync(fakeCli, 0o755);
    const originalCli = process.env.ONEMESSAGE_INSTAGRAM_CLI;
    process.env.ONEMESSAGE_INSTAGRAM_CLI = fakeCli;

    try {
      const result = await instagramProvider.send("fixture-recipient", "fixture body", {
        providerFlags: { username: "fixture-instagram-sender" },
      });

      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(getCachedMessage("instagram", "fixture-instagram-sent")?.account).toBe(
        "fixture-instagram-sender",
      );
    } finally {
      if (originalCli === undefined) delete process.env.ONEMESSAGE_INSTAGRAM_CLI;
      else process.env.ONEMESSAGE_INSTAGRAM_CLI = originalCli;
    }
  });
});
