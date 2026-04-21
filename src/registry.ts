import type { MessagingProvider } from "./types.ts";

const providers = new Map<string, MessagingProvider>();

export function registerProvider(provider: MessagingProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: string): MessagingProvider | undefined {
  return providers.get(name);
}

export function getAllProviders(): MessagingProvider[] {
  return Array.from(providers.values());
}

export function getProviderOrExit(name: string): MessagingProvider {
  const provider = getProvider(name);
  if (!provider) {
    const available = getAllProviders()
      .map((p) => p.name)
      .join(", ");
    console.error(`Unknown provider: "${name}"`);
    console.error(`Available: ${available || "(none)"}`);
    process.exit(1);
  }
  return provider;
}
