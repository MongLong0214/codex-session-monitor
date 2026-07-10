"use client";

import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { AgentActionType } from "@/domain/agent/actions";
import styles from "./operations-table.module.css";

const BULK_ACTIONS: { action: AgentActionType; label: string; variant: "secondary" | "destructive" }[] = [
  { action: "pause", label: "일시정지", variant: "secondary" },
  { action: "resume", label: "재개", variant: "secondary" },
  { action: "retry", label: "재시도", variant: "secondary" },
  { action: "stop", label: "중지", variant: "destructive" },
];

interface BulkActionBarProps {
  selectedCount: number;
  isPending: boolean;
  onAction: (action: AgentActionType) => void;
  onClearSelection: () => void;
}

/**
 * Appears only while a selection exists. `useBulkAgentAction()` has no optimistic path — a bulk
 * result is per-agent partial success — so every button here waits for the server and reports
 * success/failure/skipped counts through a toast rather than guessing.
 */
export function BulkActionBar({ selectedCount, isPending, onAction, onClearSelection }: BulkActionBarProps) {
  return (
    <HStack className={styles.bulkBar} gap={2} vAlign="center" role="region" aria-label="선택한 에이전트 일괄 작업">
      <Text type="label" hasTabularNumbers>
        {selectedCount}개 선택됨
      </Text>
      <HStack gap={1} vAlign="center">
        {BULK_ACTIONS.map((bulkAction) => (
          <Button
            key={bulkAction.action}
            label={bulkAction.label}
            variant={bulkAction.variant}
            size="sm"
            isDisabled={isPending}
            onClick={() => onAction(bulkAction.action)}
          />
        ))}
      </HStack>
      <Button label="선택 해제" variant="ghost" size="sm" onClick={onClearSelection} />
    </HStack>
  );
}
