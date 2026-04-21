import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, loadConfig, saveConfig } from "../config.ts";
import { registerProvider } from "../registry.ts";
import * as store from "../store.ts";
import type { MessageEnvelope, MessagingProvider } from "../types.ts";
import { cacheSentMessage, readFromCacheOrFail } from "./shared.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface MatrixSettings {
  homeserver: string;
  userId: string;
  accessToken: string;
}

function resolveSettings(cliOverrides?: Record<string, unknown>): MatrixSettings | null {
  const cfg = loadConfig().matrix;
  const homeserver = (cliOverrides?.homeserver as string) ?? cfg?.homeserver;
  const userId = (cliOverrides?.userId as string) ?? cfg?.userId;
  const accessToken = (cliOverrides?.accessToken as string) ?? cfg?.accessToken;
  if (!homeserver || !userId || !accessToken) return null;
  return { homeserver: homeserver.replace(/\/$/, ""), userId, accessToken };
}

// ---------------------------------------------------------------------------
// Matrix Client-Server API helpers
// ---------------------------------------------------------------------------

async function matrixApi(
  method: string,
  path: string,
  settings: MatrixSettings,
  body?: unknown,
  // biome-ignore lint/suspicious/noExplicitAny: Matrix API returns varying JSON shapes
): Promise<any> {
  const url = `${settings.homeserver}/_matrix/client/v3${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${settings.accessToken}`,
  };
  const init: RequestInit = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Matrix ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Recipient resolution
// ---------------------------------------------------------------------------

async function resolveRoomId(recipient: string, settings: MatrixSettings): Promise<string> {
  if (recipient.startsWith("!")) return recipient;

  if (recipient.startsWith("#")) {
    const data = await matrixApi(
      "GET",
      `/directory/room/${encodeURIComponent(recipient)}`,
      settings,
    );
    return data.room_id;
  }

  if (recipient.startsWith("@")) {
    const dmRoomId = await findExistingDm(recipient, settings);
    if (dmRoomId) return dmRoomId;

    const data = await matrixApi("POST", "/createRoom", settings, {
      is_direct: true,
      invite: [recipient],
      preset: "trusted_private_chat",
    });
    return data.room_id;
  }

  // Bare word — fuzzy match against joined room names
  const joined = await matrixApi("GET", "/joined_rooms", settings);
  const roomIds = joined.joined_rooms as string[];

  let bestMatch: string | null = null;
  const lowerRecipient = recipient.toLowerCase();

  for (const roomId of roomIds) {
    try {
      const state = await matrixApi(
        "GET",
        `/rooms/${encodeURIComponent(roomId)}/state/m.room.name`,
        settings,
      );
      const name = (state.name as string) ?? "";
      if (name.toLowerCase() === lowerRecipient) return roomId;
      if (!bestMatch && name.toLowerCase().includes(lowerRecipient)) {
        bestMatch = roomId;
      }
    } catch {
      // Room has no name — skip
    }
  }

  if (bestMatch) return bestMatch;
  throw new Error(
    `No joined room matching "${recipient}". Use a full room ID (!...), alias (#...), or user ID (@...).`,
  );
}

async function findExistingDm(userId: string, settings: MatrixSettings): Promise<string | null> {
  try {
    const data = await matrixApi(
      "GET",
      `/user/${encodeURIComponent(settings.userId)}/account_data/m.direct`,
      settings,
    );
    const rooms = data[userId] as string[] | undefined;
    if (rooms && rooms.length > 0) return rooms[0] ?? null;
  } catch {
    // No m.direct data or 404 — no existing DMs
  }
  return null;
}

// ---------------------------------------------------------------------------
// Room metadata helpers
// ---------------------------------------------------------------------------

async function getRoomName(roomId: string, settings: MatrixSettings): Promise<string> {
  try {
    const state = await matrixApi(
      "GET",
      `/rooms/${encodeURIComponent(roomId)}/state/m.room.name`,
      settings,
    );
    if (state.name) return state.name;
  } catch {
    // No name set
  }
  return roomId;
}

async function getRoomMemberCount(roomId: string, settings: MatrixSettings): Promise<number> {
  try {
    const data = await matrixApi(
      "GET",
      `/rooms/${encodeURIComponent(roomId)}/joined_members`,
      settings,
    );
    return Object.keys(data.joined ?? {}).length;
  } catch {
    return 0;
  }
}

function displayNameFromUserId(userId: string): string {
  return userId.split(":")[0]?.slice(1) ?? userId;
}

// ---------------------------------------------------------------------------
// Sync token persistence (stored in config dir to avoid polluting messages)
// ---------------------------------------------------------------------------

function getSyncTokenPath(settings: MatrixSettings): string {
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });
  // Use homeserver and userId hash to support multiple accounts
  const hashValue = Bun.hash(`${settings.homeserver}:${settings.userId}`);
  const hash = (
    typeof hashValue === "bigint" ? Number(hashValue & 0xffffffffn) : hashValue >>> 0
  ).toString(36);
  return join(configDir, `matrix-sync-${hash}.token`);
}

function getSyncToken(settings: MatrixSettings): string | null {
  try {
    const path = getSyncTokenPath(settings);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8").trim();
  } catch {
    return null;
  }
}

function saveSyncToken(settings: MatrixSettings, token: string): void {
  try {
    const path = getSyncTokenPath(settings);
    writeFileSync(path, token, "utf-8");
  } catch (err) {
    console.error(
      `[matrix] Failed to save sync token: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Fetch and cache
// ---------------------------------------------------------------------------

export async function fetchMatrixMessages(settings: MatrixSettings): Promise<void> {
  const params = new URLSearchParams({
    timeout: "0",
    filter: JSON.stringify({
      room: {
        timeline: { limit: 50 },
        state: { lazy_load_members: true },
      },
    }),
  });

  const syncToken = getSyncToken(settings);
  if (syncToken) {
    params.set("since", syncToken);
  }

  const data = await matrixApi("GET", `/sync?${params}`, settings);

  if (data.next_batch) {
    saveSyncToken(settings, data.next_batch);
  }

  const joinedRooms = data.rooms?.join;
  if (!joinedRooms) {
    store.recordFetch("matrix", settings.userId);
    return;
  }

  const envelopes: MessageEnvelope[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: Matrix sync response rooms are untyped
  for (const [roomId, roomData] of Object.entries(joinedRooms as Record<string, any>)) {
    // biome-ignore lint/suspicious/noExplicitAny: Matrix sync response timeline is untyped
    const events = (roomData as any).timeline?.events ?? [];
    const messageEvents = events.filter(
      // biome-ignore lint/suspicious/noExplicitAny: Matrix event objects are untyped
      (e: any) =>
        e.type === "m.room.message" &&
        e.content?.body &&
        e.content?.["m.relates_to"]?.rel_type !== "m.replace",
    );

    if (messageEvents.length === 0) continue;

    const [roomName, memberCount] = await Promise.all([
      getRoomName(roomId, settings),
      getRoomMemberCount(roomId, settings),
    ]);
    const isGroup = memberCount > 2;

    for (const event of messageEvents) {
      const senderName = displayNameFromUserId(event.sender);
      envelopes.push({
        id: event.event_id,
        provider: "matrix",
        from: { name: senderName, address: event.sender },
        to: [{ name: roomName, address: roomId }],
        preview: (event.content.body as string).slice(0, 100),
        date: new Date(event.origin_server_ts).toISOString(),
        unread: event.sender !== settings.userId,
        hasAttachments: false,
        isGroup,
        groupName: isGroup ? roomName : undefined,
      });
    }
  }

  if (envelopes.length > 0) {
    store.upsertMessages(envelopes);
  }

  store.recordFetch("matrix", settings.userId);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const matrixProvider: MessagingProvider = {
  name: "matrix",
  displayName: "Matrix",

  isConfigured() {
    return resolveSettings() !== null;
  },

  async send(recipientId, body, opts) {
    const settings = resolveSettings(opts?.providerFlags);
    if (!settings) {
      return {
        ok: false,
        provider: "matrix",
        recipientId,
        error: "Matrix not configured. Run: onemessage auth matrix",
      };
    }

    try {
      const roomId = await resolveRoomId(recipientId, settings);
      const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
      const data = await matrixApi(
        "PUT",
        `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
        settings,
        { msgtype: "m.text", body },
      );

      const messageId = data.event_id as string;
      cacheSentMessage({
        provider: "matrix",
        messageId,
        fromAddress: settings.userId,
        recipientId: roomId,
        body,
      });

      return { ok: true, provider: "matrix", recipientId, messageId };
    } catch (err) {
      return {
        ok: false,
        provider: "matrix",
        recipientId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async inbox(opts) {
    const settings = resolveSettings(opts?.providerFlags);
    if (!settings) {
      console.error("Matrix not configured. Run: onemessage auth matrix");
      return [];
    }

    if (store.isFresh("matrix", 30_000, settings.userId) && !opts?.fresh) {
      return store.getCachedInbox("matrix", {
        limit: opts?.limit,
        unread: opts?.unread,
        since: opts?.since,
        from: opts?.from,
      });
    }

    try {
      await fetchMatrixMessages(settings);
    } catch (err) {
      console.error(
        `[matrix] Failed to fetch messages: ${err instanceof Error ? err.message : err}`,
      );
    }

    return store.getCachedInbox("matrix", {
      limit: opts?.limit,
      unread: opts?.unread,
      since: opts?.since,
      from: opts?.from,
    });
  },

  async read(messageId) {
    return readFromCacheOrFail("matrix", messageId);
  },

  async search(query, opts) {
    return store.searchCached(query, "matrix", {
      limit: opts?.limit,
      since: opts?.since,
    });
  },

  async authenticate() {
    const config = loadConfig();
    if (config.matrix?.accessToken) {
      console.log(
        `Matrix already configured: ${config.matrix.userId} on ${config.matrix.homeserver}`,
      );
      return;
    }

    const readline = await import("node:readline");
    const { Writable } = await import("node:stream");

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

    const homeserver = (await ask("Homeserver URL (e.g. https://matrix.org): ")).trim();
    const userId = (await ask("User ID (e.g. @you:matrix.org): ")).trim();
    rl.close();

    // Muted output stream suppresses echo for password input
    const muted = new Writable({ write: (_c, _e, cb) => cb() });
    const rlSecret = readline.createInterface({
      input: process.stdin,
      output: muted,
      terminal: true,
    });
    process.stdout.write("Password: ");
    const password = await new Promise<string>((resolve) =>
      rlSecret.question("", (answer) => {
        rlSecret.close();
        process.stdout.write("\n");
        resolve(answer);
      }),
    );

    const res = await fetch(`${homeserver.replace(/\/$/, "")}/_matrix/client/v3/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: userId },
        password,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Login failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      device_id: string;
      user_id: string;
    };

    config.matrix = {
      homeserver: homeserver.replace(/\/$/, ""),
      userId: data.user_id,
      accessToken: data.access_token,
      deviceId: data.device_id,
    };
    saveConfig(config);

    console.log(`\nMatrix authenticated as ${data.user_id}`);
    console.log(`Device: ${data.device_id}`);
  },
};

registerProvider(matrixProvider);
