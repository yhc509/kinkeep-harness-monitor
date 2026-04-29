import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import { overviewResponseSchema } from "@codex-monitor/shared";
import type { AppConfig } from "./config";
import { loadConfig } from "./config";
import { CompositeProvider } from "./lib/composite-provider";
import { TokenCollectorService } from "./lib/token-collector";
import { createProviderRegistry } from "./lib/provider-registry";
import { registerTokenAttributionRoutes } from "./routes/tokens/attribution";
import { registerTokenCacheRoutes } from "./routes/tokens/cache";

export async function buildServer(config: AppConfig = loadConfig()) {
  const app = Fastify({
    logger: true
  });
  const providerRegistry = createProviderRegistry(config);
  const providers = providerRegistry.getProviders();
  const provider = new CompositeProvider(providers);
  const collectorService = new TokenCollectorService(config, providers);

  collectorService.ensureSchema();
  provider.ensureMonitorSchema();

  await app.register(cors, {
    origin: true
  });

  app.get("/api/health", async () => ({
    ok: true,
    timezone: config.timezone,
    provider: config.activeProviderIds[0],
    providers: config.activeProviderIds
  }));

  app.get("/api/overview", async () => {
    const overview = provider.getOverview(collectorService.getOverviewTokens(7));
    return overviewResponseSchema.parse({
      ...overview,
      collector: collectorService.getLastRun()
    });
  });

  app.get("/api/projects", async (request) => {
    const query = request.query as {
      query?: string;
      limit?: string;
    };

    return provider.listProjects({
      query: query.query,
      limit: query.limit ? Number(query.limit) : undefined
    });
  });

  app.get("/api/sessions", async (request) => {
    const query = request.query as {
      query?: string;
      projectId?: string;
      includeSubagents?: string;
      sort?: "updatedAt" | "tokensUsed" | "createdAt";
      order?: "asc" | "desc";
      limit?: string;
    };

    return provider.listSessions({
      query: query.query,
      projectId: query.projectId,
      includeSubagents: query.includeSubagents === "true",
      sort: query.sort,
      order: query.order,
      limit: query.limit ? Number(query.limit) : undefined
    });
  });

  app.get("/api/sessions/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const detail = provider.getSessionDetail(params.id);

    if (!detail) {
      reply.code(404);
      return { message: "Session not found" };
    }

    return detail;
  });

  app.get("/api/memory", async () => provider.getMemory());
  app.get("/api/integrations", async () => provider.getIntegrations());
  app.get("/api/integrations/hooks/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const detail = provider.getHookDetail(params.id);

    if (!detail) {
      reply.code(404);
      return { message: "Hook not found" };
    }

    return detail;
  });
  app.get("/api/integrations/skills/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const detail = provider.getSkillDetail(params.id);

    if (!detail) {
      reply.code(404);
      return { message: "Skill not found" };
    }

    return detail;
  });
  app.post("/api/integrations/refresh", async () => {
    await provider.refreshIntegrationsUsageInBackground();
    return provider.getIntegrations();
  });

  app.get("/api/tokens", async (request) => {
    const query = request.query as { range?: string };
    const rangeDays = Number(query.range ?? "7");
    return collectorService.getTokens(Number.isNaN(rangeDays) ? 7 : Math.max(1, rangeDays));
  });

  app.get("/api/tokens/project-usage", async (request) => {
    const query = request.query as { unit?: string; anchor?: string };
    const unit = query.unit === "week" || query.unit === "month"
      ? query.unit
      : "day";

    return collectorService.getProjectTokenUsage(unit, query.anchor, new Date());
  });

  registerTokenCacheRoutes(app, config);
  registerTokenAttributionRoutes(app, config);

  app.post("/api/tokens/snapshot", async () => {
    const result = await collectorService.refreshUsageCacheInBackground(true, new Date());
    return result ?? collectorService.captureSnapshot();
  });

  if (fs.existsSync(config.webDistPath)) {
    await app.register(staticPlugin, {
      root: config.webDistPath,
      prefix: "/"
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/")) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }

      reply.type("text/html").send(fs.readFileSync(path.join(config.webDistPath, "index.html"), "utf8"));
    });
  }

  await collectorService.refreshUsageCacheInBackground(false, new Date());
  await provider.ensureFreshIntegrationsUsage();

  return app;
}
