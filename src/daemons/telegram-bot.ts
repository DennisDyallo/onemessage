import { loadConfig } from "../config.ts";
import { fetchTelegramBotUpdates } from "../providers/telegram-bot.ts";
import type { DaemonOrchestrator, ProviderAdapter } from "./adapter.ts";

export class TelegramBotAdapter implements ProviderAdapter {
  readonly name = "telegram-bot";
  readonly polling = true;
  private botToken: string | null = null;

  start(orchestrator: DaemonOrchestrator): void {
    const config = loadConfig();
    this.botToken = config.telegramBot?.botToken ?? null;
    if (!this.botToken) return;

    const enabled = config.daemon?.providers?.["telegram-bot"]?.enabled !== false;
    if (!enabled) return;

    const interval =
      config.daemon?.providers?.["telegram-bot"]?.pollIntervalMs ??
      orchestrator.defaultPollInterval();

    const botToken = this.botToken;
    orchestrator.schedulePoll("telegram-bot", interval, () => fetchTelegramBotUpdates(botToken));
  }

  async fetch(): Promise<void> {
    if (!this.botToken) throw new Error("Telegram Bot not configured");
    await fetchTelegramBotUpdates(this.botToken);
  }

  isActive(): boolean {
    return this.botToken !== null;
  }

  statusInfo(): Record<string, unknown> {
    return {};
  }

  cleanup(): void {
    // Telegram Bot has no persistent resources
  }
}
