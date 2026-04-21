/**
 * Core types for the onemessage unified messaging CLI.
 *
 * Every messaging platform implements the MessagingProvider interface.
 * The CLI dispatches to providers via the registry.
 */

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface MessageEnvelope {
  id: string;
  provider: string;
  account?: string; // which account this message belongs to (email only)
  from: Contact | null;
  to: Contact[];
  subject?: string;
  preview: string;
  date: string;
  unread: boolean;
  hasAttachments: boolean;
  isGroup?: boolean; // true = group, false = 1:1, undefined = unknown
  groupName?: string; // human-readable group name when isGroup is true
  direction?: "in" | "out";
}

export interface MessageFull extends MessageEnvelope {
  body: string;
  bodyFormat: "text" | "html";
  attachments: Attachment[];
  /** RFC 822 Message-ID header (e.g. "<abc123@mail.example.com>") */
  rfcMessageId?: string;
  direction: "in" | "out";
}

export interface Contact {
  name: string;
  address: string;
}

export interface Attachment {
  filename: string;
  contentType: string;
  size: number;
  data?: string; // base64
}

// ---------------------------------------------------------------------------
// Provider options
// ---------------------------------------------------------------------------

export interface SendOptions {
  subject?: string;
  html?: boolean;
  file?: string;
  attachments?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  account?: string;
  /** RFC 822 Message-ID of the message being replied to (for In-Reply-To/References headers) */
  inReplyTo?: string;
  /** Provider-specific CLI flag overrides (password, host, port, etc.) */
  providerFlags?: Record<string, unknown>;
}

export interface SendResult {
  ok: boolean;
  provider: string;
  recipientId: string;
  messageId?: string;
  error?: string;
}

export interface InboxOptions {
  limit?: number;
  unread?: boolean;
  since?: string;
  from?: string;
  folder?: string;
  account?: string;
  fresh?: boolean;
  all?: boolean;
  providerFlags?: Record<string, unknown>;
}

export interface ReadOptions {
  folder?: string;
  account?: string;
  prefer?: "text" | "html";
  includeAttachments?: boolean;
  fresh?: boolean;
  providerFlags?: Record<string, unknown>;
}

export interface SearchOptions {
  limit?: number;
  folder?: string;
  account?: string;
  since?: string;
  fresh?: boolean;
  providerFlags?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface MessagingProvider {
  /** Short lowercase name: "email", "signal", "telegram", etc. */
  name: string;

  /** Human-readable display name */
  displayName: string;

  /** Check whether this provider has valid configuration */
  isConfigured(): boolean;

  /** Send a message to a recipientId (email address, phone number, username) */
  send(recipientId: string, body: string, opts?: SendOptions): Promise<SendResult>;

  /** List recent messages */
  inbox(opts?: InboxOptions): Promise<MessageEnvelope[]>;

  /** Read a specific message by ID */
  read(messageId: string, opts?: ReadOptions): Promise<MessageFull | null>;

  /** Search messages (optional — not all providers support this) */
  search?(query: string, opts?: SearchOptions): Promise<MessageEnvelope[]>;

  /** Interactive authentication flow — only providers that need one implement this */
  authenticate?(opts?: { phone?: string }): Promise<void>;
}
