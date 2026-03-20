import type { AppConfig } from "../config";
import { ClaudeCodeDataService } from "./claude-code-service";
import { CodexDataService } from "./codex-service";
import type { MonitorProviderAdapter } from "./provider-adapter";

export interface ProviderRegistry {
  getActiveProvider(): MonitorProviderAdapter;
  getProviders(): MonitorProviderAdapter[];
}

export function createProviderRegistry(config: AppConfig): ProviderRegistry {
  let providers: MonitorProviderAdapter[] | null = null;

  return {
    getActiveProvider() {
      const [provider] = this.getProviders();
      if (!provider) {
        throw new Error(`No supported providers are available for: ${config.activeProviderIds.join(", ")}`);
      }

      return provider;
    },
    getProviders() {
      if (providers) {
        return providers;
      }

      providers = config.activeProviderIds.flatMap<MonitorProviderAdapter>((providerId) => {
        if (providerId === "codex") {
          return [new CodexDataService(config)];
        }

        if (providerId === "claude-code") {
          return [new ClaudeCodeDataService(config)];
        }

        console.warn(`[provider-registry] Skipping unsupported provider until implementation is ready: ${providerId}`);
        return [];
      });

      return providers;
    }
  };
}
