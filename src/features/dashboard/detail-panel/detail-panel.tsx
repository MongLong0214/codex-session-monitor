"use client";

import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { LayoutPanel } from "@astryxdesign/core/Layout";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useState, type RefObject } from "react";
import type { Agent, AgentId } from "@/domain/agent/agent";
import { useAgent } from "@/lib/query/use-agent";
import { STATUS_DOT_VARIANT, STATUS_LABEL } from "../status-presentation";
import { AgentActions } from "./agent-actions";
import { ChangesTab } from "./changes-tab";
import styles from "./detail-panel.module.css";
import { LogsTab } from "./logs-tab";
import { OverviewTab } from "./overview-tab";

type TabValue = "overview" | "logs" | "changes";

const PANEL_MIN_WIDTH_PX = 380;
const PANEL_DEFAULT_WIDTH_PX = 420;
const PANEL_MAX_WIDTH_PX = 520;

/** Elapsed time is the only ticking value in the panel; a coarse tick keeps it honest without churn. */
const ELAPSED_TICK_MS = 30_000;

export interface DetailPanelProps {
  /** Null closes the panel: nothing renders, and neither the agent nor the log query is mounted. */
  agentId: AgentId | null;
  onClose: () => void;
  /**
   * Focus-return contract: the parent passes a ref to the element that opened the panel (the table
   * row's open control). Escape and the close button focus it again before calling `onClose`.
   * Optional — when omitted, focus simply stays where it was.
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Rules-of-hooks boundary: `useAgent` takes a non-null AgentId, so the null check lives here, before
 * any hook runs, and the content component below always receives a concrete id. Flipping `agentId`
 * between null and an id mounts/unmounts DetailPanelContent instead of reordering a hook list.
 */
export function DetailPanel({ agentId, onClose, restoreFocusRef }: DetailPanelProps) {
  if (agentId === null) {
    return null;
  }

  return <DetailPanelContent agentId={agentId} onClose={onClose} {...(restoreFocusRef ? { restoreFocusRef } : {})} />;
}

interface DetailPanelContentProps {
  agentId: AgentId;
  onClose: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

function DetailPanelContent({ agentId, onClose, restoreFocusRef }: DetailPanelContentProps) {
  const [activeTab, setActiveTab] = useState<TabValue>("overview");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { data: agent, isLoading } = useAgent(agentId);

  const panel = useResizable({
    defaultSize: PANEL_DEFAULT_WIDTH_PX,
    minSizePx: PANEL_MIN_WIDTH_PX,
    maxSizePx: PANEL_MAX_WIDTH_PX,
    autoSaveId: "codex-detail-panel",
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      /** An open AlertDialog handles Escape first; defaultPrevented stops the panel closing behind it. */
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      restoreFocusRef?.current?.focus();
      onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, restoreFocusRef]);

  const handleClose = () => {
    restoreFocusRef?.current?.focus();
    onClose();
  };

  return (
    <LayoutPanel
      className={styles.panel}
      resizable={panel.props}
      isScrollable={false}
      padding={0}
      role="complementary"
      label="에이전트 상세"
    >
      {/* Overlay mode anchors to `.panel`'s position: relative; isReversed because this is an end panel. */}
      <ResizeHandle
        resizable={panel.props}
        direction="horizontal"
        position="overlay"
        isReversed
        label="상세 패널 너비 조절"
      />

      <VStack gap={3} padding={3}>
        <HStack gap={2} vAlign="start" hAlign="between">
          <Text type="large" weight="semibold" maxLines={2}>
            {agent?.displayName ?? "에이전트"}
          </Text>
          <IconButton
            label="상세 패널 닫기"
            icon={<Icon icon="close" />}
            variant="ghost"
            size="sm"
            onClick={handleClose}
          />
        </HStack>

        {isLoading && !agent ? <Spinner size="md" label="에이전트를 불러오는 중" /> : null}

        {!isLoading && !agent ? (
          <EmptyState
            isCompact
            title="에이전트를 찾을 수 없습니다"
            description="이 세션은 더 이상 관찰되지 않습니다. 목록에서 다른 세션을 선택하세요."
          />
        ) : null}

        {agent ? <AgentHeader agent={agent} /> : null}
      </VStack>

      {agent ? (
        <>
          <TabList
            value={activeTab}
            onChange={(value) => setActiveTab(value as TabValue)}
            aria-label="에이전트 상세 탭"
            hasDivider
            size="sm"
          >
            <Tab value="overview" label="개요" />
            <Tab value="logs" label="로그" />
            <Tab value="changes" label="변경 사항" />
          </TabList>

          {/* Exactly one body is mounted: that unmount/mount IS the lazy-load boundary for the log query. */}
          <VStack className={styles.tabPanel}>
            {activeTab === "overview" ? <OverviewTab agent={agent} nowMs={nowMs} /> : null}
            {activeTab === "logs" ? <LogsTab agentId={agent.id} /> : null}
            {activeTab === "changes" ? <ChangesTab agent={agent} /> : null}
          </VStack>
        </>
      ) : null}
    </LayoutPanel>
  );
}

/** Always visible above the tabs: identity, status, location, current task and the primary actions. */
function AgentHeader({ agent }: { agent: Agent }) {
  return (
    <VStack gap={2}>
      <HStack gap={1} vAlign="center" wrap="wrap">
        <StatusDot variant={STATUS_DOT_VARIANT[agent.status.kind]} label={STATUS_LABEL[agent.status.kind]} />
        <Text type="body">{STATUS_LABEL[agent.status.kind]}</Text>
        <Text type="supporting">·</Text>
        <Text type="supporting">{agent.project.name}</Text>
      </HStack>

      {agent.branch ? (
        <HStack gap={1} vAlign="center">
          <Text type="supporting">브랜치</Text>
          <Text type="code">{agent.branch}</Text>
        </HStack>
      ) : null}

      {agent.currentTask ? (
        <VStack gap={0.5}>
          <Text type="label">현재 작업</Text>
          <Text type="body" as="p" maxLines={3} className={styles.wrapAnywhere}>
            {agent.currentTask}
          </Text>
        </VStack>
      ) : null}

      <AgentActions agent={agent} />
    </VStack>
  );
}
