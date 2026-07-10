"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { createQueryClient } from "@/lib/query/query-client";

/**
 * NOTE for the app-shell task: this provider deliberately does NOT mount `useRealtimeSync()`.
 * The hook returns the connection status the shell has to render anyway (connected /
 * reconnecting / stale / offline), and owning it here would mean re-exposing that status
 * through a context this project has no need for. Call `useRealtimeSync()` once from the
 * client component that renders the connection indicator, anywhere beneath this provider.
 *
 * `useState(() => ...)` keeps one QueryClient per component lifetime — a module-level client
 * would leak cache between requests on the server and between remounts here.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
