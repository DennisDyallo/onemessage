import type { MessageFull, ThreadMetadata } from "./types.ts";

const UNSAFE_USER = /^User_\d+$/i;
const NUMERIC = /^\d+$/;

export interface ProviderThread {
  id: string;
  title?: string | null;
  users?: string[];
  isGroup?: boolean;
  lastActivity: string;
}

export type InstagramThreadMetadata = ThreadMetadata & { defaultSenderLabel: string };

export function internalThreadAddress(
  thread: Pick<ThreadMetadata, "provider" | "account" | "threadId">,
): string {
  const identity = [thread.provider, thread.account, thread.threadId]
    .map((part) => encodeURIComponent(part))
    .join(":");
  return `internal-thread:${identity}`;
}

export function instagramDefaultSenderLabel(
  thread: Pick<ThreadMetadata, "isGroup" | "participantHandles">,
): string {
  if (!thread.isGroup && thread.participantHandles.length === 1) {
    return `@${thread.participantHandles[0]}`;
  }
  return "Instagram Participant";
}

export function isHumanSafeIdentity(value: string | null | undefined, threadId?: string): boolean {
  const candidate = value?.trim();
  if (!candidate || candidate === threadId) return false;
  return !UNSAFE_USER.test(candidate) && !NUMERIC.test(candidate);
}

export function normalizeInstagramHandle(value: string | null | undefined): string | null {
  const handle = value?.trim().replace(/^@/, "");
  if (!handle || !/^[A-Za-z0-9._]+$/.test(handle) || !isHumanSafeIdentity(handle)) return null;
  return handle;
}

export function normalizeInstagramThread(
  thread: ProviderThread,
  account: string,
): Omit<ThreadMetadata, "updatedAt" | "defaultSenderLabel"> {
  const ownHandle = normalizeInstagramHandle(account)?.toLowerCase();
  const participantHandles = [
    ...new Set(
      (thread.users ?? [])
        .map(normalizeInstagramHandle)
        .filter((handle): handle is string => handle !== null)
        .filter((handle) => handle.toLowerCase() !== ownHandle),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const isGroup = thread.isGroup ?? participantHandles.length > 1;
  const title = isHumanSafeIdentity(thread.title, thread.id)
    ? (thread.title?.trim() ?? null)
    : null;
  const displayName =
    title ?? (!isGroup && participantHandles.length === 1 ? `@${participantHandles[0]}` : null);

  return {
    provider: "instagram",
    account,
    threadId: thread.id,
    title,
    displayName,
    isGroup,
    participantHandles,
    lastActivity: thread.lastActivity,
    resolved: displayName !== null,
  };
}

export function markDuplicateThreadIdentitiesUnresolved(
  threads: ThreadMetadata[],
): ThreadMetadata[] {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    if (!thread.displayName) continue;
    const key = thread.displayName.normalize("NFKC").toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return threads.map((thread) => {
    if (!thread.displayName) return thread;
    const key = thread.displayName.normalize("NFKC").toLocaleLowerCase();
    return counts.get(key) === 1 ? thread : { ...thread, displayName: null, resolved: false };
  });
}

export function normalizeInstagramMessage(
  message: MessageFull,
  thread: InstagramThreadMetadata,
): MessageFull {
  if (message.direction === "out") {
    return {
      ...message,
      from: { name: "me", address: "me" },
      to: [
        {
          name: thread.displayName ?? "Instagram Conversation",
          address: internalThreadAddress(thread),
        },
      ],
    };
  }

  const handle =
    normalizeInstagramHandle(message.from?.address) ?? normalizeInstagramHandle(message.from?.name);
  const sender = handle ? `@${handle}` : thread.defaultSenderLabel;
  return {
    ...message,
    from: { name: sender, address: handle ?? "instagram-participant" },
    to: [{ name: "me", address: "me" }],
  };
}
