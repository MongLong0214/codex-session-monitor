import type { SearchableItem } from "@astryxdesign/core/Typeahead";
import type { AgentActionType } from "@/domain/agent/actions";
import type { Agent, AgentId } from "@/domain/agent/agent";
import type { DashboardSnapshot } from "@/domain/dashboard";
import type { RowDensity, ThemeMode } from "@/domain/settings";
import { resolveActionAvailability } from "../detail-panel/action-availability";
import { STATUS_LABEL } from "../status-presentation";
import { deriveBranchOptions } from "../table/filter-sort";

/** Group headings, in the order the palette renders them (first-seen wins). */
export const COMMAND_GROUP = {
  currentAgent: "현재 에이전트",
  theme: "테마",
  density: "표시 밀도",
  agents: "에이전트",
  projects: "프로젝트",
  branches: "브랜치",
} as const;

interface CommandItemAux {
  /** Drives CommandPalette's automatic section grouping. */
  group: string;
  /** Extra search terms matched alongside the label (createStaticSource `keywords`). */
  keywords: string[];
}

/** A CommandPalette item plus the effect to run when it is selected (looked up by `id`). */
export type CommandDescriptor = SearchableItem<CommandItemAux> & { run: () => void };

export interface CommandPaletteCallbacks {
  onOpenAgentDetail: (agentId: AgentId) => void;
  onApplyProjectFilter: (cwd: string) => void;
  onApplyBranchFilter: (branch: string) => void;
  onSetTheme: (theme: ThemeMode) => void;
  onSetDensity: (density: RowDensity) => void;
  /** stop routes through a confirmation dialog upstream; pause/resume fire immediately. */
  onRunAgentAction: (agent: Agent, action: AgentActionType) => void;
}

export interface BuildCommandItemsInput {
  snapshot: DashboardSnapshot | undefined;
  /** The agent whose detail panel is open, if any — the target of the "current agent" actions. */
  currentAgent: Agent | null;
  callbacks: CommandPaletteCallbacks;
}

const THEME_OPTIONS: { mode: ThemeMode; label: string; keywords: string[] }[] = [
  { mode: "light", label: "테마: 라이트", keywords: ["theme", "light", "라이트", "밝게"] },
  { mode: "dark", label: "테마: 다크", keywords: ["theme", "dark", "다크", "어둡게"] },
  { mode: "system", label: "테마: 시스템", keywords: ["theme", "system", "시스템", "자동"] },
];

const DENSITY_OPTIONS: { density: RowDensity; label: string; keywords: string[] }[] = [
  { density: "compact", label: "밀도: 조밀", keywords: ["density", "compact", "조밀"] },
  { density: "comfortable", label: "밀도: 여유", keywords: ["density", "comfortable", "여유"] },
];

/**
 * The four control actions offered for the current agent. `retry` is listed so its availability is
 * evaluated by the same `resolveActionAvailability` the detail panel uses — which reports it
 * permanently disabled (no control channel), so it is filtered out below rather than offered as a
 * guaranteed no-op. pause/resume/stop survive only when the agent has an observed runtime process.
 */
const CURRENT_AGENT_ACTIONS: { action: AgentActionType; label: string; keywords: string[] }[] = [
  { action: "pause", label: "현재 에이전트 정지 (SIGSTOP)", keywords: ["pause", "정지", "일시정지", "sigstop"] },
  { action: "resume", label: "현재 에이전트 재개 (SIGCONT)", keywords: ["resume", "재개", "sigcont"] },
  { action: "retry", label: "현재 에이전트 재시도", keywords: ["retry", "재시도"] },
  { action: "stop", label: "현재 에이전트 중지 (SIGTERM)", keywords: ["stop", "중지", "종료", "sigterm"] },
];

/**
 * Builds the full command list from the live snapshot, the current selection, and the callbacks
 * that carry out each effect. Pure and deterministic given its input, so the matching/availability
 * behavior is unit-testable without mounting the palette. The order here is the render order:
 * contextual current-agent actions first, then the finite settings commands, then the searchable
 * agent / project / branch entities.
 */
export function buildCommandItems({ snapshot, currentAgent, callbacks }: BuildCommandItemsInput): CommandDescriptor[] {
  const items: CommandDescriptor[] = [];

  if (currentAgent) {
    const agent = currentAgent;
    for (const { action, label, keywords } of CURRENT_AGENT_ACTIONS) {
      if (resolveActionAvailability(agent, action).isDisabled) {
        continue;
      }
      items.push({
        id: `action:${action}`,
        label,
        auxiliaryData: { group: COMMAND_GROUP.currentAgent, keywords: [...keywords, agent.displayName] },
        run: () => callbacks.onRunAgentAction(agent, action),
      });
    }
  }

  for (const { mode, label, keywords } of THEME_OPTIONS) {
    items.push({
      id: `theme:${mode}`,
      label,
      auxiliaryData: { group: COMMAND_GROUP.theme, keywords },
      run: () => callbacks.onSetTheme(mode),
    });
  }

  for (const { density, label, keywords } of DENSITY_OPTIONS) {
    items.push({
      id: `density:${density}`,
      label,
      auxiliaryData: { group: COMMAND_GROUP.density, keywords },
      run: () => callbacks.onSetDensity(density),
    });
  }

  if (snapshot) {
    for (const agentId of snapshot.allIds) {
      const agent = snapshot.byId[agentId];
      if (!agent) {
        continue;
      }
      const keywords = [agent.project.name, STATUS_LABEL[agent.status.kind]];
      if (agent.branch) {
        keywords.push(agent.branch);
      }
      items.push({
        id: `agent:${agentId}`,
        label: agent.displayName,
        auxiliaryData: { group: COMMAND_GROUP.agents, keywords },
        run: () => callbacks.onOpenAgentDetail(agentId),
      });
    }

    for (const project of snapshot.projects) {
      items.push({
        id: `project:${project.cwd}`,
        label: project.name,
        auxiliaryData: { group: COMMAND_GROUP.projects, keywords: [project.cwd] },
        run: () => callbacks.onApplyProjectFilter(project.cwd),
      });
    }

    for (const branch of deriveBranchOptions(snapshot)) {
      items.push({
        id: `branch:${branch}`,
        label: branch,
        auxiliaryData: { group: COMMAND_GROUP.branches, keywords: [] },
        run: () => callbacks.onApplyBranchFilter(branch),
      });
    }
  }

  return items;
}
