import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { apiResourceKeys, getIntegrations, getMemory, getOverview, getProjects, getTokens } from "./api";
import { AppShell } from "./components/AppShell";
import { prefetchApiResource } from "./hooks/useApiResource";
import {
  loadDashboardPage,
  loadHooksPage,
  loadMemoryPage,
  loadMcpPage,
  loadCachePage,
  loadSessionsPage,
  loadSkillsPage,
  loadTokensPage,
  loadToolsPage,
  prefetchAllRoutes
} from "./route-prefetch";

const DashboardPage = lazy(async () => loadDashboardPage().then((module) => ({ default: module.DashboardPage })));
const SessionsPage = lazy(async () => loadSessionsPage().then((module) => ({ default: module.SessionsPage })));
const MemoryPage = lazy(async () => loadMemoryPage().then((module) => ({ default: module.MemoryPage })));
const McpPage = lazy(async () => loadMcpPage().then((module) => ({ default: module.McpPage })));
const HooksPage = lazy(async () => loadHooksPage().then((module) => ({ default: module.HooksPage })));
const SkillsPage = lazy(async () => loadSkillsPage().then((module) => ({ default: module.SkillsPage })));
const TokensPage = lazy(async () => loadTokensPage().then((module) => ({ default: module.TokensPage })));
const ToolsPage = lazy(async () => loadToolsPage().then((module) => ({ default: module.ToolsPage })));
const CachePage = lazy(async () => loadCachePage().then((module) => ({ default: module.CachePage })));

export function App() {
  useEffect(() => {
    const browserWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    let delayedIntegrationsPrefetchId: number | null = null;
    const prefetch = () => {
      void prefetchAllRoutes();
      void prefetchApiResource(apiResourceKeys.overview, () => getOverview(), { staleTimeMs: 300_000 });
      void prefetchApiResource(apiResourceKeys.tokens(7), () => getTokens(7), { staleTimeMs: 300_000 });
      void prefetchApiResource(apiResourceKeys.projects(""), () => getProjects(""), { staleTimeMs: 300_000 });
      void prefetchApiResource(apiResourceKeys.memory, () => getMemory(), { staleTimeMs: 300_000 });

      delayedIntegrationsPrefetchId = browserWindow.setTimeout(() => {
        void prefetchApiResource(apiResourceKeys.integrations, () => getIntegrations(), { staleTimeMs: 0 });
      }, 1_500);
    };

    if (typeof browserWindow.requestIdleCallback === "function" && typeof browserWindow.cancelIdleCallback === "function") {
      const idleId = browserWindow.requestIdleCallback(prefetch, { timeout: 2_000 });
      return () => {
        if (delayedIntegrationsPrefetchId !== null) {
          browserWindow.clearTimeout(delayedIntegrationsPrefetchId);
        }
        browserWindow.cancelIdleCallback(idleId);
      };
    }

    const timeoutId = browserWindow.setTimeout(prefetch, 600);
    return () => {
      if (delayedIntegrationsPrefetchId !== null) {
        browserWindow.clearTimeout(delayedIntegrationsPrefetchId);
      }
      browserWindow.clearTimeout(timeoutId);
    };
  }, []);

  return (
    <Suspense fallback={<div className="route-fallback">Loading page</div>}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/projects/:projectId" element={<SessionsPage />} />
          <Route path="/sessions/projects/:projectId/:sessionId" element={<SessionsPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/integrations" element={<Navigate to="/mcp" replace />} />
          <Route path="/mcp" element={<McpPage />} />
          <Route path="/hooks" element={<HooksPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/tokens" element={<TokensPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/cache" element={<CachePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
