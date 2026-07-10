"use client";

import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useState } from "react";
import type { AgentActionResult, AgentActionType } from "@/domain/agent/actions";
import type { Agent } from "@/domain/agent/agent";
import { useAgentAction } from "@/lib/query/use-agent-action";
import { NO_CONTROL_CHANNEL_REASON, resolveActionAvailability } from "./action-availability";
import styles from "./detail-panel.module.css";

const RESULT_BANNER_STATUS: Record<AgentActionResult["status"], "success" | "warning" | "error"> = {
  success: "success",
  failed: "error",
  skipped: "warning",
};

const RESULT_BANNER_TITLE: Record<AgentActionResult["status"], string> = {
  success: "동작을 실행했습니다",
  failed: "동작이 실패했습니다",
  skipped: "동작을 건너뛰었습니다",
};

/**
 * Deliberately NOT status-conditional. SIGSTOP/SIGCONT are OS signals; the local adapter's
 * classifier has no evidence to ever report `paused`, so hiding "재개" until the agent looks paused
 * would strand a user who just suspended a process. Both stay visible, both say what they really send.
 */
const SIGNAL_TOOLTIP: Partial<Record<AgentActionType, string>> = {
  pause: "OS 레벨 프로세스 일시정지(SIGSTOP)를 보냅니다. 세션 자체의 pause 기능이 아닙니다.",
  resume: "OS 레벨 프로세스 재개(SIGCONT)를 보냅니다. 세션 자체의 resume 기능이 아닙니다.",
  open_terminal: "작업 디렉터리를 터미널에서 엽니다.",
};

const STOP_DIALOG_DESCRIPTION =
  "작업 디렉터리를 공유하는 프로세스에 SIGTERM을 보냅니다. 세션과 프로세스의 직접 매핑이 없어 같은 디렉터리의 다른 세션도 함께 종료될 수 있습니다. 되돌릴 수 없습니다.";

interface AgentActionsProps {
  agent: Agent;
}

export function AgentActions({ agent }: AgentActionsProps) {
  const [isStopDialogOpen, setStopDialogOpen] = useState(false);
  const { mutate, data: result, isPending, error, variables } = useAgentAction();

  const runAction = (action: AgentActionType) => {
    /** No optimisticStatus anywhere here: the adapter can't report `paused`, and `stop` is unpredictable. */
    mutate({ agentId: agent.id, request: { action } });
  };

  const confirmStop = () => {
    setStopDialogOpen(false);
    runAction("stop");
  };

  const renderAction = (action: AgentActionType, label: string) => {
    const { isDisabled, reason } = resolveActionAvailability(agent, action);
    const tooltip = reason ?? SIGNAL_TOOLTIP[action];
    /** Only the in-flight action's own button shows the spinner; the rest merely lock out. */
    const isRunning = isPending && variables?.request.action === action;

    return (
      <Button
        key={action}
        label={label}
        size="sm"
        variant="secondary"
        isDisabled={isDisabled || isPending}
        isLoading={isRunning}
        {...(tooltip ? { tooltip } : {})}
        onClick={() => runAction(action)}
      />
    );
  };

  const stopAvailability = resolveActionAvailability(agent, "stop");

  return (
    <VStack gap={2}>
      <HStack gap={1} wrap="wrap" vAlign="center">
        <Button
          label="중지"
          size="sm"
          variant="destructive"
          icon={<Icon icon="stop" />}
          isDisabled={stopAvailability.isDisabled || isPending}
          isLoading={isPending && variables?.request.action === "stop"}
          {...(stopAvailability.reason ? { tooltip: stopAvailability.reason } : {})}
          onClick={() => setStopDialogOpen(true)}
        />
        {renderAction("pause", "정지(SIGSTOP)")}
        {renderAction("resume", "재개(SIGCONT)")}
        {renderAction("open_terminal", "터미널 열기")}
        {renderAction("retry", "재시도")}
        {renderAction("approve", "승인")}
        {renderAction("reject", "거부")}
      </HStack>

      {/* The disabled buttons carry this as a tooltip, but a hover-only explanation is not enough. */}
      <Text type="supporting" as="p" className={styles.reasonNote}>
        재시도 · 승인 · 거부는 항상 비활성입니다. {NO_CONTROL_CHANNEL_REASON}
      </Text>

      {error ? (
        <Banner container="section" status="error" title="요청을 보내지 못했습니다" description={error.message} />
      ) : null}

      {result && !error ? (
        <Banner
          container="section"
          status={RESULT_BANNER_STATUS[result.status]}
          title={RESULT_BANNER_TITLE[result.status]}
          description={result.message}
        />
      ) : null}

      <AlertDialog
        isOpen={isStopDialogOpen}
        onOpenChange={setStopDialogOpen}
        title={`${agent.displayName} 중지`}
        description={STOP_DIALOG_DESCRIPTION}
        actionLabel="중지"
        cancelLabel="취소"
        actionVariant="destructive"
        isActionLoading={isPending}
        onAction={confirmStop}
      />
    </VStack>
  );
}
