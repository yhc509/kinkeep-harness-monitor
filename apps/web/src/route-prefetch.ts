const routeLoaders = {
  dashboard: () => import("./pages/DashboardPage"),
  sessions: () => import("./pages/SessionsPage"),
  memory: () => import("./pages/MemoryPage"),
  integrations: () => import("./pages/IntegrationsPage"),
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

export function loadIntegrationsPage() {
  return routeLoaders.integrations();
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

  if (pathname.startsWith("/integrations")) {
    return routeLoaders.integrations();
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
    routeLoaders.integrations(),
    routeLoaders.tokens()
  ]);
}
