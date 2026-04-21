/**
 * Base interfaces for daemon provider adapters.
 * Each provider implements ProviderAdapter and optionally IpcCapableAdapter
 * to handle polling, IPC requests, and lifecycle management.
 */

export interface DaemonOrchestrator {
  /** Schedule a periodic poll for a provider. */
  schedulePoll(name: string, intervalMs: number, fn: () => Promise<void>): void;

  /** Trigger an immediate poll (used for testing and IPC fetch). */
  pollNow(name: string, fn: () => Promise<void>): Promise<void>;

  /** Update the last-poll timestamp for a provider. */
  setLastPoll(name: string): void;

  /** Default poll interval (in ms) when provider config doesn't specify one. */
  defaultPollInterval(): number;
}

export interface ProviderAdapter {
  /** Unique provider name (e.g., "email", "signal", "whatsapp"). */
  readonly name: string;

  /** Whether this provider uses polling (true) or real-time connections (false). */
  readonly polling: boolean;

  /**
   * Start the provider.
   * - Polling providers: call orchestrator.schedulePoll()
   * - Real-time providers: open connection, register event handlers
   */
  start(orchestrator: DaemonOrchestrator): void | Promise<void>;

  /** Fetch messages immediately (called by IPC "fetch" command). */
  fetch(): Promise<void>;

  /** Whether this provider is currently active/configured. */
  isActive(): boolean;

  /** Extra fields to merge into IPC "status" response for this provider. */
  statusInfo(): Record<string, unknown>;

  /** Graceful cleanup on daemon shutdown. */
  cleanup(): void;
}

export interface IpcCapableAdapter extends ProviderAdapter {
  /**
   * Handle a provider-specific IPC request.
   * Return { ok: true, data?: ... } or { ok: false, error: string } to handle.
   * Return undefined to pass to the next adapter.
   */
  handleIpc(req: Record<string, unknown>): Promise<DaemonResponse | undefined>;

  /** List IPC request types this adapter handles (for introspection). */
  ipcTypes(): string[];
}

export type DaemonResponse = { ok: true; data?: unknown } | { ok: false; error: string };

export function isIpcCapable(adapter: ProviderAdapter): adapter is IpcCapableAdapter {
  return "handleIpc" in adapter && "ipcTypes" in adapter;
}
