import type { Metadata } from "next";
import type { ReactNode } from "react";
import { QueryProvider } from "@/components/providers/query-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Session Monitor",
  description: "로컬 Codex·Claude Code 에이전트 세션 모니터",
};

/**
 * The Astryx `ThemeProvider` is intentionally NOT mounted here. Its mode is driven by persisted
 * settings, whose single owner (`DashboardApp`) lives under this layout — so the provider is
 * mounted there, where it can be fed the stored theme. QueryProvider stays global because the
 * snapshot query has no such per-page ownership.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
