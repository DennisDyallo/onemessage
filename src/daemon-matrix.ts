import { loadConfig } from "./config.ts";
import type { DaemonOrchestrator, ProviderAdapter } from "./daemon-adapter.ts";
import { fetchMatrixMessages } from "./providers/matrix.ts";

// ---------------------------------------------------------------------------
// Settings resolution (mirrors providers/matrix.ts resolveSettings)
// ---------------------------------------------------------------------------

function resolveMatrixSettings(): {
  homeserver: string;
  userId: string;
  accessToken: string;
} | null {
  const cfg = loadConfig().matrix;
  if (!cfg?.homeserver || !cfg?.userId || !cfg?.accessToken) return null;
  return {
    homeserver: cfg.homeserver.replace(/\/$/, ""),
    userId: cfg.userId,
    accessToken: cfg.accessToken,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class MatrixAdapter implements ProviderAdapter {
  readonly name = "matrix";
  readonly polling = true;
  private active = false;

  start(orchestrator: DaemonOrchestrator): void {
    // Check if matrix is configured at startup (for isActive reporting),
    // but resolve settings inside each poll so config changes take effect
    // without a daemon restart.
    const initialSettings = resolveMatrixSettings();
    if (!initialSettings) return;

    this.active = true;

    const config = loadConfig();
    const enabled = config.daemon?.providers?.matrix?.enabled !== false;
    if (!enabled) return;

    const interval =
      config.daemon?.providers?.matrix?.pollIntervalMs ?? orchestrator.defaultPollInterval();

    orchestrator.schedulePoll("matrix", interval, async () => {
      const settings = resolveMatrixSettings();
      if (!settings) return;
      await fetchMatrixMessages(settings);
    });
  }

  async fetch(): Promise<void> {
    const settings = resolveMatrixSettings();
    if (!settings) throw new Error("Matrix not configured");
    await fetchMatrixMessages(settings);
  }

  isActive(): boolean {
    return this.active;
  }

  statusInfo(): Record<string, unknown> {
    return {};
  }

  cleanup(): void {
    // Matrix has no persistent resources
  }
}
