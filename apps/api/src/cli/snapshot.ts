import { loadConfig } from "../config";
import { TokenCollectorService } from "../lib/token-collector";
import { createProviderRegistry } from "../lib/provider-registry";

const config = loadConfig();
const providerRegistry = createProviderRegistry(config);
const collector = new TokenCollectorService(config, providerRegistry.getProviders());

try {
  const result = collector.captureSnapshot();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error);
  process.exit(1);
}
