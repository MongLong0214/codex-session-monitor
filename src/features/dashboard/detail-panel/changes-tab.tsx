"use client";

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useRef } from "react";
import type { AgentActionResult, AgentActionType } from "@/domain/agent/actions";
import type { Agent } from "@/domain/agent/agent";
import { useAgentAction } from "@/lib/query/use-agent-action";
import { resolveActionAvailability } from "./action-availability";

/** `git diff --stat` output, already truncated server-side. "변경 사항이 없습니다." is a success too. */
function DiffOutput({ result }: { result: AgentActionResult }) {
  if (result.status === "success") {
    return <CodeBlock code={result.message} language="plaintext" container="section" width="100%" size="sm" isWrapped maxHeight={360} />;
  }

  return (
    <Banner
      container="section"
      status={result.status === "skipped" ? "warning" : "error"}
      title="변경 사항을 확인할 수 없습니다"
      description={result.message}
    />
  );
}

/**
 * There is no live diff feed and no GET endpoint for one: `view_diff` runs `git diff --stat` in the
 * agent's cwd on demand and answers through the action result. What renders below is therefore a
 * point-in-time snapshot, taken when this tab opened or when the user pressed 새로고침.
 */
export function ChangesTab({ agent }: { agent: Agent }) {
  const diff = useAgentAction();
  const pullRequest = useAgentAction();

  const { mutate: runDiff } = diff;
  const lastLoadedAgentId = useRef<string | null>(null);

  useEffect(() => {
    if (lastLoadedAgentId.current === agent.id) {
      return;
    }

    lastLoadedAgentId.current = agent.id;
    runDiff({ agentId: agent.id, request: { action: "view_diff" } });
  }, [agent.id, runDiff]);

  const renderPullRequestAction = (action: AgentActionType, label: string) => {
    const { isDisabled, reason } = resolveActionAvailability(agent, action);

    return (
      <Button
        label={label}
        size="sm"
        variant="secondary"
        isDisabled={isDisabled || pullRequest.isPending}
        isLoading={pullRequest.isPending && pullRequest.variables?.request.action === action}
        {...(reason ? { tooltip: reason } : {})}
        onClick={() => pullRequest.mutate({ agentId: agent.id, request: { action } })}
      />
    );
  };

  const diffAvailability = resolveActionAvailability(agent, "view_diff");

  return (
    <VStack gap={3}>
      <HStack gap={1} wrap="wrap" vAlign="center">
        <Button
          label="새로고침"
          size="sm"
          variant="secondary"
          isDisabled={diffAvailability.isDisabled || diff.isPending}
          isLoading={diff.isPending}
          {...(diffAvailability.reason ? { tooltip: diffAvailability.reason } : {})}
          onClick={() => diff.mutate({ agentId: agent.id, request: { action: "view_diff" } })}
        />
        {renderPullRequestAction("create_pr", "PR 생성")}
        {renderPullRequestAction("open_pr", "PR 열기")}
      </HStack>

      <Text type="supporting" as="p">
        {agent.branch ? `브랜치 ${agent.branch}의 ` : ""}git diff --stat 결과입니다. 실시간으로 갱신되지 않습니다.
      </Text>

      {/* gh can be missing, unauthenticated, or have nothing to PR — surface its real message. */}
      {pullRequest.error ? (
        <Banner container="section" status="error" title="요청을 보내지 못했습니다" description={pullRequest.error.message} />
      ) : null}

      {pullRequest.data && !pullRequest.error ? (
        <Banner
          container="section"
          status={pullRequest.data.status === "success" ? "success" : "error"}
          title={pullRequest.data.status === "success" ? "완료" : "실패"}
          description={pullRequest.data.message}
        />
      ) : null}

      {diff.isPending ? <Spinner size="md" label="변경 사항을 읽는 중" /> : null}

      {diff.error ? (
        <Banner container="section" status="error" title="diff를 불러오지 못했습니다" description={diff.error.message} />
      ) : null}

      {diff.data && !diff.isPending && !diff.error ? <DiffOutput result={diff.data} /> : null}

      {!diff.data && !diff.isPending && !diff.error ? (
        <EmptyState isCompact title="변경 사항을 불러오지 않았습니다" description="새로고침을 눌러 현재 git diff를 확인하세요." />
      ) : null}
    </VStack>
  );
}
