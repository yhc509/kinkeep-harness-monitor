import { loadConfig } from "../config";
import { CodexDataService } from "../lib/codex-service";
import { TokenCollectorService } from "../lib/token-collector";

const config = loadConfig();
const codexService = new CodexDataService(config);
const collector = new TokenCollectorService(config, codexService);

try {
  const result = collector.captureSnapshot();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error);
  process.exit(1);
}
