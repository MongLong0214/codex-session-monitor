"use client";

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import type { Incident, IncidentSeverity } from "@/domain/incident/incident";

const SEVERITY_TO_BANNER_STATUS: Record<IncidentSeverity, "error" | "warning" | "info"> = {
  critical: "error",
  high: "warning",
  medium: "warning",
  low: "info",
};

interface IncidentStripProps {
  /** Pre-filtered to critical/high by the caller, sorted worst-first. Renders nothing when empty. */
  incidents: Incident[];
  onSelectIncident: (incident: Incident) => void;
}

export function IncidentStrip({ incidents, onSelectIncident }: IncidentStripProps) {
  const primary = incidents[0];
  if (!primary) {
    return null;
  }
  const remaining = incidents.length - 1;

  return (
    <Banner
      container="section"
      status={SEVERITY_TO_BANNER_STATUS[primary.severity]}
      title={primary.summary}
      description={`${primary.evidence} · 권장 조치: ${primary.suggestedAction}`}
      endContent={
        <Button label="자세히 보기" variant="secondary" size="sm" onClick={() => onSelectIncident(primary)} />
      }
    >
      {remaining > 0 ? <Text type="supporting">그 외 {remaining}건의 문제가 더 있습니다.</Text> : null}
    </Banner>
  );
}
