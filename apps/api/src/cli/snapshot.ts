import { loadConfig } from "../config";
import { TokenCollectorService } from "../lib/token-collector";
import { createProviderRegistry } from "../lib/provider-registry";

const config = loadConfig();
const provider = createProviderRegistry(config).getActiveProvider();
const collector = new TokenCollectorService(config, provider);

try {
  const result = collector.captureSnapshot();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error);
  process.exit(1);
}
