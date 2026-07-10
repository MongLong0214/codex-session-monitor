"use client";

import { ToastViewport } from "@astryxdesign/core/Toast";
import { useCallback, useState } from "react";
import type { AgentId } from "@/domain/agent/agent";
import type { DashboardSettings } from "@/domain/settings";
import { DashboardCommandPalette } from "./command-palette/dashboard-command-palette";
import { DetailPanel } from "./detail-panel/detail-panel";
import { OperationsTable } from "./table/operations-table";
import { tableStateFromSettings } from "./table/settings-mapping";
import { useAgentTableState } from "./table/use-table-state";

interface DashboardWorkspaceProps {
  settings: DashboardSettings;
  onUpdateSettings: (patch: Partial<DashboardSettings>) => void;
  isCommandPaletteOpen: boolean;
  onCommandPaletteOpenChange: (isOpen: boolean) => void;
}

/**
 * Owns the high-frequency table state (filters, sorting, column sizing, selection) beneath the app
 * shell, so a column-resize drag or a search keystroke re-renders only this subtree — never the top
 * bar, side nav, or incident strip above it. It is also the shared owner the command palette needs:
 * one `useAgentTableState` instance drives both the table and the palette's filter/density commands.
 * Column-width persistence is debounced in the hook, so the single settle-time write (which does
 * bubble a settings change up to the shell) fires once per resize, not once per frame.
 */
export function DashboardWorkspace({
  settings,
  onUpdateSettings,
  isCommandPaletteOpen,
  onCommandPaletteOpenChange,
}: DashboardWorkspaceProps) {
  // Captured once: mounted only after settings hydrate, so this is the stored value, not the default.
  const [initialTableState] = useState(() => tableStateFromSettings(settings));
  const tableState = useAgentTableState({ initialState: initialTableState, onPersist: onUpdateSettings });

  const [selectedAgentId, setSelectedAgentId] = useState<AgentId | null>(null);

  const { setProjectCwds, setBranches, setDensity } = tableState;
  const applyProjectFilter = useCallback((cwd: string) => setProjectCwds([cwd]), [setProjectCwds]);
  const applyBranchFilter = useCallback((branch: string) => setBranches([branch]), [setBranches]);
  const setTheme = useCallback((theme: DashboardSettings["theme"]) => onUpdateSettings({ theme }), [onUpdateSettings]);

  return (
    <ToastViewport>
      <OperationsTable tableState={tableState} onOpenDetail={setSelectedAgentId} />
      <DetailPanel agentId={selectedAgentId} onClose={() => setSelectedAgentId(null)} />
      <DashboardCommandPalette
        isOpen={isCommandPaletteOpen}
        onOpenChange={onCommandPaletteOpenChange}
        selectedAgentId={selectedAgentId}
        onOpenAgentDetail={setSelectedAgentId}
        onApplyProjectFilter={applyProjectFilter}
        onApplyBranchFilter={applyBranchFilter}
        onSetTheme={setTheme}
        onSetDensity={setDensity}
      />
    </ToastViewport>
  );
}
