"use client";

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useEffect, useRef, useState } from "react";
import type { AgentId } from "@/domain/agent/agent";
import type { AgentLogLevel, AgentLogLine } from "@/domain/agent/logs";
import { DEFAULT_AGENT_LOG_LIMIT } from "@/domain/agent/logs";
import { useAgentLogs } from "@/lib/query/use-agent-logs";
import styles from "./logs-tab.module.css";

type LevelFilter = "all" | AgentLogLevel;

/** Within this distance of the bottom the view counts as "following"; further up it is "reading". */
const PINNED_THRESHOLD_PX = 24;
const COPIED_FEEDBACK_MS = 2_000;

/**
 * The severity filter is structurally present but only "전체"/"정보" can ever match: neither Codex's
 * rollout events nor Claude Code's session JSONL carry a severity field (see domain/agent/logs.ts),
 * so every line either reader emits is "info". The two unreachable segments are disabled rather
 * than silently returning zero rows, and no keyword-guessing classifier is used to fake them.
 */
const UNREACHABLE_LEVEL_REASON = "이 세션의 로그 형식에는 심각도 필드가 없어 경고·오류를 구분할 수 없습니다.";

function toClipboardText(lines: readonly AgentLogLine[]): string {
  return lines.map((line) => `${line.timestamp ?? ""}\t${line.text}`).join("\n");
}

/**
 * Mounted only while its tab is selected and the panel is open — that mount IS the lazy-load
 * boundary, so the log query never runs for a closed panel or an unselected tab.
 */
export function LogsTab({ agentId }: { agentId: AgentId }) {
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [isCopied, setCopied] = useState(false);

  const { data, isLoading, isError, error, refetch, isFetching } = useAgentLogs(agentId, { isEnabled: true });

  const scrollRef = useRef<HTMLElement>(null);
  const isPinnedRef = useRef(true);

  const lines = data?.lines ?? [];
  const visibleLines = levelFilter === "all" ? lines : lines.filter((line) => line.level === levelFilter);

  /** Follow new output only when the user is already at the bottom; never yank them out of history. */
  useEffect(() => {
    const region = scrollRef.current;
    if (region && isPinnedRef.current) {
      region.scrollTop = region.scrollHeight;
    }
  }, [visibleLines]);

  useEffect(() => {
    if (!isCopied) {
      return;
    }

    const timer = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [isCopied]);

  const handleScroll = () => {
    const region = scrollRef.current;
    if (region) {
      isPinnedRef.current = region.scrollHeight - region.scrollTop - region.clientHeight <= PINNED_THRESHOLD_PX;
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(toClipboardText(visibleLines));
    setCopied(true);
  };

  return (
    <VStack gap={2} height="100%">
      <HStack gap={2} vAlign="center" hAlign="between" wrap="wrap">
        <SegmentedControl
          size="sm"
          label="로그 심각도 필터"
          value={levelFilter}
          onChange={(value) => setLevelFilter(value as LevelFilter)}
        >
          <SegmentedControlItem value="all" label="전체" />
          <SegmentedControlItem value="info" label="정보" />
          <SegmentedControlItem value="warning" label="경고" isDisabled />
          <SegmentedControlItem value="error" label="오류" isDisabled />
        </SegmentedControl>

        <HStack gap={1} vAlign="center">
          <Button
            label="새로고침"
            size="sm"
            variant="ghost"
            isLoading={isFetching}
            onClick={() => {
              void refetch();
            }}
          />
          <Button
            label={isCopied ? "복사됨" : "복사"}
            size="sm"
            variant="ghost"
            icon={<Icon icon={isCopied ? "checkDouble" : "copy"} />}
            isDisabled={visibleLines.length === 0}
            onClick={() => {
              void handleCopy();
            }}
          />
        </HStack>
      </HStack>

      <Text type="supporting" as="p">
        {UNREACHABLE_LEVEL_REASON} 최근 {DEFAULT_AGENT_LOG_LIMIT}줄까지 표시합니다.
      </Text>

      {data?.isTruncated ? (
        <Banner
          container="section"
          status="info"
          title="오래된 로그는 생략되었습니다"
          description="롤아웃 파일의 마지막 구간만 읽으므로 이보다 앞선 기록은 이 화면에 없습니다."
        />
      ) : null}

      {isError ? (
        <Banner
          container="section"
          status="error"
          title="로그를 불러오지 못했습니다"
          description={error instanceof Error ? error.message : "알 수 없는 오류"}
        />
      ) : null}

      {isLoading ? (
        <Spinner size="md" label="로그를 불러오는 중" />
      ) : (
        <VStack
          ref={scrollRef}
          className={styles.scrollRegion}
          onScroll={handleScroll}
          /* role="log" already implies aria-live="polite"; stable line ids mean only new rows announce. */
          role="log"
          aria-label="에이전트 활동 로그"
          tabIndex={0}
        >
          {visibleLines.length === 0 ? (
            <EmptyState isCompact title="표시할 로그가 없습니다" description="이 세션의 롤아웃 파일에서 읽을 수 있는 활동 기록이 아직 없습니다." />
          ) : (
            <ol className={styles.lineList}>
              {visibleLines.map((line) => (
                <li key={line.id} className={styles.line}>
                  {line.timestamp ? (
                    <Timestamp value={line.timestamp} format="system_time" hasTooltip={false} />
                  ) : (
                    <Text type="supporting">—</Text>
                  )}
                  <Text type="code" className={styles.lineText}>
                    {line.text}
                  </Text>
                </li>
              ))}
            </ol>
          )}
        </VStack>
      )}
    </VStack>
  );
}
