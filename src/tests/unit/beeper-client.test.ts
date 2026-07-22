import { afterEach, describe, expect, test } from "bun:test";
import {
  type BeeperConnection,
  beeperApi,
  beeperMessageId,
  listBeeperAccounts,
  normalizeBeeperBaseUrl,
  parseBeeperMessageId,
  parsePendingBeeperMessageId,
  pendingBeeperMessageId,
  resolveBeeperConnection,
} from "../../providers/beeper-client.ts";

const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("shared Beeper Client API", () => {
  test("allows HTTPS and loopback HTTP but rejects unsafe HTTP and credentials", () => {
    expect(normalizeBeeperBaseUrl("https://beeper.example///")).toBe("https://beeper.example");
    expect(normalizeBeeperBaseUrl("http://127.0.0.2:23373/")).toBe("http://127.0.0.2:23373");
    expect(normalizeBeeperBaseUrl("http://[::1]:23373")).toBe("http://[::1]:23373");
    expect(normalizeBeeperBaseUrl("http://beeper.example")).toBeNull();
    expect(normalizeBeeperBaseUrl("http://127.attacker.example")).toBeNull();
    expect(normalizeBeeperBaseUrl("https://token@beeper.example")).toBeNull();
  });

  test("uses top-level config before the narrow Messenger legacy fallback", () => {
    expect(
      resolveBeeperConnection(
        { accessToken: " shared ", baseUrl: "https://shared.example/" },
        undefined,
        { accessToken: "legacy", baseUrl: "https://legacy.example" },
      ),
    ).toEqual({ accessToken: "shared", baseUrl: "https://shared.example" });
    expect(
      resolveBeeperConnection(undefined, undefined, {
        accessToken: " legacy ",
        baseUrl: "http://127.0.0.1:23373/",
      }),
    ).toEqual({ accessToken: "legacy", baseUrl: "http://127.0.0.1:23373" });
  });

  test("message IDs are chat-scoped, collision-safe, and reversible", () => {
    const id = beeperMessageId("chat:a/b", "message:c/d");
    expect(id).not.toBe(beeperMessageId("chat:a", "b:message:c/d"));
    expect(parseBeeperMessageId(id)).toEqual({ chatId: "chat:a/b", messageId: "message:c/d" });
    const pending = pendingBeeperMessageId("chat:a/b", "pending:c/d");
    expect(parsePendingBeeperMessageId(pending)).toEqual({
      chatId: "chat:a/b",
      messageId: "pending:c/d",
    });
    expect(parsePendingBeeperMessageId(id)).toBeNull();
  });

  test("authenticates requests and redacts tokens from API errors", async () => {
    const token = "fixture-secret-token";
    let authorization = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        authorization = request.headers.get("authorization") ?? "";
        return new Response(`failure ${token}`, { status: 503 });
      },
    });
    servers.push(server);
    const connection: BeeperConnection = {
      accessToken: token,
      baseUrl: `http://127.0.0.1:${server.port}`,
    };

    let error = "";
    try {
      await beeperApi("Fixture", "GET", "/v1/accounts", connection);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    expect(authorization).toBe(`Bearer ${token}`);
    expect(error).toContain("failure [redacted]");
    expect(error).not.toContain(token);
  });

  test("normalizes account-list response variants", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ accounts: [{ id: "gmessages", network: "gmessages" }] });
      },
    });
    servers.push(server);
    expect(
      await listBeeperAccounts("Fixture", {
        accessToken: "fixture",
        baseUrl: `http://127.0.0.1:${server.port}`,
      }),
    ).toEqual([{ id: "gmessages", network: "gmessages" }]);
  });

  test("refuses transport paths that escape the configured API origin", async () => {
    const connection: BeeperConnection = {
      accessToken: "fixture",
      baseUrl: "http://127.0.0.1:23373",
    };
    await expect(
      beeperApi("Fixture", "GET", "//example.com/v1/accounts", connection),
    ).rejects.toThrow("outside the configured origin");
  });
});
