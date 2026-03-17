import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import { overviewResponseSchema } from "@codex-monitor/shared";
import type { AppConfig } from "./config";
import { loadConfig } from "./config";
import { CodexDataService } from "./lib/codex-service";
import { TokenCollectorService } from "./lib/token-collector";

export async function buildServer(config: AppConfig = loadConfig()) {
  const app = Fastify({
    logger: true
  });
  const codexService = new CodexDataService(config);
  const collectorService = new TokenCollectorService(config, codexService);

  collectorService.ensureSchema();
  codexService.ensureMonitorSchema();

  await app.register(cors, {
    origin: true
  });

  app.get("/api/health", async () => ({
    ok: true,
    timezone: config.timezone
  }));

  app.get("/api/overview", async () => {
    const overview = codexService.getOverview(collectorService.getOverviewTokens(7));
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

    return codexService.listProjects({
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

    return codexService.listSessions({
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
    const detail = codexService.getSessionDetail(params.id);

    if (!detail) {
      reply.code(404);
      return { message: "세션 없음" };
    }

    return detail;
  });

  app.get("/api/memory", async () => codexService.getMemory());
  app.get("/api/integrations", async () => codexService.getIntegrations());
  app.get("/api/integrations/hooks/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const detail = codexService.getHookDetail(params.id);

    if (!detail) {
      reply.code(404);
      return { message: "Hook 없음" };
    }

    return detail;
  });
  app.get("/api/integrations/skills/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const detail = codexService.getSkillDetail(params.id);

    if (!detail) {
      reply.code(404);
      return { message: "Skill 없음" };
    }

    return detail;
  });
  app.post("/api/integrations/refresh", async () => {
    await codexService.refreshIntegrationsUsageInBackground();
    return codexService.getIntegrations();
  });

  app.get("/api/tokens", async (request) => {
    const query = request.query as { range?: string };
    const rangeDays = Number(query.range ?? "7");
    return collectorService.getTokens(Number.isNaN(rangeDays) ? 7 : Math.max(1, rangeDays));
  });

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
  await codexService.ensureFreshIntegrationsUsage();

  return app;
}
