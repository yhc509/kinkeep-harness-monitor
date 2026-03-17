import { startTransition, useEffect, useEffectEvent, useState } from "react";

interface ResourceState<T> {
  data: T | null;
  initialLoading: boolean;
  refreshing: boolean;
  error: string | null;
  hasData: boolean;
}

interface UseApiResourceOptions {
  deps: ReadonlyArray<unknown>;
  cacheKey: string;
  enabled?: boolean;
  keepPreviousData?: boolean;
  staleTimeMs?: number;
}

interface ResourceCacheEntry<T> {
  data?: T;
  error: string | null;
  updatedAt: number;
  promise: Promise<T> | null;
}

const resourceCache = new Map<string, ResourceCacheEntry<unknown>>();

function getCacheEntry<T>(cacheKey: string): ResourceCacheEntry<T> | undefined {
  return resourceCache.get(cacheKey) as ResourceCacheEntry<T> | undefined;
}

function ensureCacheEntry<T>(cacheKey: string): ResourceCacheEntry<T> {
  const existing = getCacheEntry<T>(cacheKey);
  if (existing) {
    return existing;
  }

  const entry: ResourceCacheEntry<T> = {
    data: undefined,
    error: null,
    updatedAt: 0,
    promise: null
  };
  resourceCache.set(cacheKey, entry);
  return entry;
}

function hasFreshData<T>(entry: ResourceCacheEntry<T> | undefined, staleTimeMs: number): boolean {
  return entry?.data !== undefined && (Date.now() - entry.updatedAt) <= staleTimeMs;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "알 수 없는 오류";
}

function buildCachedState<T>(cacheKey: string): ResourceState<T> {
  const entry = getCacheEntry<T>(cacheKey);
  if (entry?.data === undefined) {
    return {
      data: null,
      initialLoading: true,
      refreshing: false,
      error: null,
      hasData: false
    };
  }

  return {
    data: entry.data,
    initialLoading: false,
    refreshing: false,
    error: entry.error,
    hasData: true
  };
}

function resolveResource<T>(
  cacheKey: string,
  loader: () => Promise<T>,
  options: {
    force?: boolean;
    staleTimeMs?: number;
  } = {}
): Promise<T> {
  const force = options.force ?? false;
  const staleTimeMs = options.staleTimeMs ?? 0;
  const entry = ensureCacheEntry<T>(cacheKey);

  if (!force && hasFreshData(entry, staleTimeMs)) {
    return Promise.resolve(entry.data as T);
  }

  if (entry.promise) {
    return entry.promise;
  }

  entry.promise = loader()
    .then((data) => {
      entry.data = data;
      entry.error = null;
      entry.updatedAt = Date.now();
      return data;
    })
    .catch((error) => {
      entry.error = toErrorMessage(error);
      throw error;
    })
    .finally(() => {
      entry.promise = null;
    });

  return entry.promise;
}

export function prefetchApiResource<T>(
  cacheKey: string,
  loader: () => Promise<T>,
  options: {
    force?: boolean;
    staleTimeMs?: number;
  } = {}
) {
  return resolveResource(cacheKey, loader, options)
    .then(() => undefined)
    .catch(() => undefined);
}

export function invalidateApiResource(cacheKey: string) {
  resourceCache.delete(cacheKey);
}

export function useApiResource<T>(
  loader: () => Promise<T>,
  options: UseApiResourceOptions
): ResourceState<T> & { refresh: () => void } {
  const enabled = options.enabled ?? true;
  const keepPreviousData = options.keepPreviousData ?? true;
  const staleTimeMs = options.staleTimeMs ?? 30_000;
  const [state, setState] = useState<ResourceState<T>>(() => buildCachedState<T>(options.cacheKey));

  const load = useEffectEvent(async (force: boolean) => {
    if (!enabled) {
      return;
    }

    const cachedEntry = getCacheEntry<T>(options.cacheKey);
    const isFresh = hasFreshData(cachedEntry, staleTimeMs);

    if (!force && isFresh && cachedEntry?.data !== undefined) {
      setState({
        data: cachedEntry.data,
        initialLoading: false,
        refreshing: false,
        error: cachedEntry.error,
        hasData: true
      });
      return;
    }

    if (cachedEntry?.data !== undefined) {
      setState({
        data: cachedEntry.data,
        initialLoading: false,
        refreshing: true,
        error: null,
        hasData: true
      });
    } else if (keepPreviousData) {
      setState((prev) => ({
        data: prev.data,
        initialLoading: prev.data === null,
        refreshing: prev.data !== null,
        error: null,
        hasData: prev.data !== null
      }));
    } else {
      setState({
        data: null,
        initialLoading: true,
        refreshing: false,
        error: null,
        hasData: false
      });
    }

    try {
      const data = await resolveResource(options.cacheKey, loader, {
        force,
        staleTimeMs
      });

      startTransition(() => {
        setState({
          data,
          initialLoading: false,
          refreshing: false,
          error: null,
          hasData: true
        });
      });
    } catch (error) {
      const message = toErrorMessage(error);
      setState((prev) => ({
        data: keepPreviousData ? prev.data : null,
        initialLoading: false,
        refreshing: false,
        error: message,
        hasData: keepPreviousData ? prev.data !== null : false
      }));
    }
  });

  useEffect(() => {
    setState((prev) => {
      const cachedState = buildCachedState<T>(options.cacheKey);
      if (cachedState.hasData || !keepPreviousData) {
        return cachedState;
      }

      return prev;
    });
    void load(false);
  }, [enabled, options.cacheKey, staleTimeMs, keepPreviousData, ...options.deps]);

  return {
    ...state,
    refresh: () => {
      void load(true);
    }
  };
}
