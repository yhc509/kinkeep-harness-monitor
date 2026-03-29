const routeLoaders = {
  dashboard: () => import("./pages/DashboardPage"),
  sessions: () => import("./pages/SessionsPage"),
  memory: () => import("./pages/MemoryPage"),
  mcp: () => import("./pages/McpPage"),
  hooks: () => import("./pages/HooksPage"),
  skills: () => import("./pages/SkillsPage"),
  tokens: () => import("./pages/TokensPage")
};

export function loadDashboardPage() {
  return routeLoaders.dashboard();
}

export function loadSessionsPage() {
  return routeLoaders.sessions();
}

export function loadMemoryPage() {
  return routeLoaders.memory();
}

export function loadMcpPage() {
  return routeLoaders.mcp();
}

export function loadHooksPage() {
  return routeLoaders.hooks();
}

export function loadSkillsPage() {
  return routeLoaders.skills();
}

export function loadTokensPage() {
  return routeLoaders.tokens();
}

export function prefetchRoute(pathname: string) {
  if (pathname === "/") {
    return routeLoaders.dashboard();
  }

  if (pathname.startsWith("/sessions")) {
    return routeLoaders.sessions();
  }

  if (pathname.startsWith("/memory")) {
    return routeLoaders.memory();
  }

  if (pathname.startsWith("/mcp")) {
    return routeLoaders.mcp();
  }

  if (pathname.startsWith("/hooks")) {
    return routeLoaders.hooks();
  }

  if (pathname.startsWith("/skills")) {
    return routeLoaders.skills();
  }

  if (pathname.startsWith("/tokens")) {
    return routeLoaders.tokens();
  }

  return Promise.resolve(null);
}

export function prefetchAllRoutes() {
  return Promise.allSettled([
    routeLoaders.sessions(),
    routeLoaders.memory(),
    routeLoaders.mcp(),
    routeLoaders.hooks(),
    routeLoaders.skills(),
    routeLoaders.tokens()
  ]);
}
