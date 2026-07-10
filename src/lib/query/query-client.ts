import { QueryClient } from "@tanstack/react-query";

const SNAPSHOT_STALE_TIME_MS = 30_000;
const SNAPSHOT_GC_TIME_MS = 5 * 60_000;
const MAX_RETRY_DELAY_MS = 10_000;

/**
 * The SSE stream — not polling — is what keeps the cache fresh, so refetch triggers are
 * deliberately blunted: a generous staleTime stops remount thrash (the detail panel and the
 * table mount observers on the same key), and window-focus refetching would only duplicate
 * work the transport already did. Retries are bounded and apply to the initial snapshot
 * fetch only; mutations are agent side effects (pause/stop a real process) and must never
 * be replayed automatically.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: SNAPSHOT_STALE_TIME_MS,
        gcTime: SNAPSHOT_GC_TIME_MS,
        refetchOnWindowFocus: false,
        retry: 2,
        retryDelay: (attemptIndex) => Math.min(500 * 2 ** attemptIndex, MAX_RETRY_DELAY_MS),
      },
      mutations: {
        retry: 0,
      },
    },
  });
}
