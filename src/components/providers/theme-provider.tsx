"use client";

import { Theme } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import type { ReactNode } from "react";
import type { ThemeMode } from "@/domain/settings";

interface ThemeProviderProps {
  children: ReactNode;
  /** Defaults to "system". DashboardApp feeds the persisted `settings.theme` here; the command palette's theme commands change it. */
  mode?: ThemeMode;
}

export function ThemeProvider({ children, mode = "system" }: ThemeProviderProps) {
  return (
    <Theme theme={neutralTheme} mode={mode}>
      {children}
    </Theme>
  );
}
