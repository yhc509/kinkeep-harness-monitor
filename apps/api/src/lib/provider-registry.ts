import type { AppConfig } from "../config";
import { CodexDataService } from "./codex-service";
import type { MonitorProviderAdapter } from "./provider-adapter";

export interface ProviderRegistry {
  getActiveProvider(): MonitorProviderAdapter;
}

export function createProviderRegistry(config: AppConfig): ProviderRegistry {
  let activeProvider: MonitorProviderAdapter | null = null;

  return {
    getActiveProvider() {
      if (activeProvider) {
        return activeProvider;
      }

      if (config.activeProviderId === "codex") {
        activeProvider = new CodexDataService(config);
        return activeProvider;
      }

      throw new Error(`지원되지 않는 provider: ${config.activeProviderId}`);
    }
  };
}
