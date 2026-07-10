"use client";

import { Center } from "@astryxdesign/core/Center";
import { Spinner } from "@astryxdesign/core/Spinner";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { usePersistedSettings } from "@/lib/settings/use-persisted-settings";
import { DashboardRoot } from "./dashboard-root";

/**
 * Owns the persisted settings for the whole dashboard and feeds them in two directions: down into
 * the Astryx `ThemeProvider` as the active mode, and into `DashboardRoot` as the seed for every
 * persisted piece of table/shell state.
 *
 * DashboardRoot is only mounted once settings have hydrated, so its (and the table's) `useState`
 * initializers read the real stored values on their very first render instead of the pre-hydration
 * defaults. Before that, a theme-aware spinner stands in for the one-frame localStorage read — the
 * dashboard already waits on a network snapshot behind an identical spinner, so this adds no
 * perceptible delay while removing any hydrate-then-reinitialize flicker.
 */
export function DashboardApp() {
  const { settings, updateSettings, isHydrated } = usePersistedSettings();

  return (
    <ThemeProvider mode={settings.theme}>
      {isHydrated ? (
        <DashboardRoot settings={settings} onUpdateSettings={updateSettings} />
      ) : (
        <Center height="100vh">
          <Spinner size="lg" label="설정을 불러오는 중" />
        </Center>
      )}
    </ThemeProvider>
  );
}
