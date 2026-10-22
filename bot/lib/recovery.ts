import type { HostContext } from "@cursor/bdk";
import { z } from "zod";
import { incidentContinuation, INCIDENT_ID_PATTERN, validationMetrics } from "./demo.js";
import { getIncident, updateIncident, type IncidentRecord } from "./incidents.js";
import { closeLinearIssue, commentLinearIssue, type LinearCallResult } from "./linear.js";
import { isRecovered } from "./metrics.js";
import { postSlack } from "./notify.js";
import { productionResolvedPayload } from "./slack-cards.js";
import { scrubPublicText } from "./public-text.js";
import { serialize } from "./serialize.js";
import { getShipped } from "./shipped.js";

const incidentId = z.string().regex(INCIDENT_ID_PATTERN);

/**
 * One checkout metric on a recovery push. `value` is the current reading.
 * `current` is accepted as an alias. `previous` is the anomaly reading
 * shown as "before" when the incident does not already have it.
 */
export const metricReadingSchema = z
  .object({
    value: z.number().optional(),
    current: z.number().optional(),
    baseline: z.number().optional(),
    previous: z.number().optional(),
  })
  .passthrough();

/**
 * Same body as an anomaly push, plus `status` and current-versus-baseline
 * GMV and AOV. Unknown keys are ignored so an older anomaly body still parses.
 */
export const observabilityAlertSchema = z
  .object({
    incidentId,
    metric: z.string().min(1),
    env: z.string().min(1),
    baseline: z.number(),
    value: z.number(),
    window: z.string().min(1),
    status: z.union([z.string(), z.null()]).optional(),
    gmv: metricReadingSchema.nullish(),
    aov: metricReadingSchema.nullish(),
  })
  .passthrough();

export type ObservabilityAlert = z.infer<typeof observabilityAlertSchema>;

export type RecoveryOutcome = {
  closed: boolean;
  already?: boolean;
  reason?: string;
  message?: string;
  linear?: string;
};

const GMV = validationMetrics[0];
const AOV = validationMetrics[1];

/** `recovered` and `resolved` are the same event. Anything else stays an anomaly. */
export function isRecoveryStatus(status: string | null | undefined): boolean {
  if (status == null) {
    return false;
  }
  const normalized = status.trim().toLowerCase();
  return normalized === "recovered" || normalized === "resolved";
}

export function observabilityAlertDecision(
  status: string | null | undefined,
): "recovery" | "triage" {
  return isRecoveryStatus(status) ? "recovery" : "triage";
}

/**
 * Metric env for the live storefront. `demo/base` is that same environment
 * and is never repeated in Slack or Linear.
 */
export function isProductionEnv(env: string): boolean {
  const value = env.trim().toLowerCase();
  return value === "prod" || value === "production" || value === "demo/base";
}

type Reading = { after: number; baseline: number; previous?: number };

export function recoveryReadings(body: ObservabilityAlert): {
  complete: boolean;
  recovered: boolean;
  gmv?: Reading;
  aov?: Reading;
} {
  const gmv = readingFor(body.gmv, body, GMV);
  const aov = readingFor(body.aov, body, AOV);
  const complete = gmv !== undefined && aov !== undefined;
  const recovered =
    complete &&
    gmv !== undefined &&
    aov !== undefined &&
    isRecovered(gmv.after, gmv.baseline) &&
    isRecovered(aov.after, aov.baseline);
  return {
    complete,
    recovered,
    ...(gmv === undefined ? {} : { gmv }),
    ...(aov === undefined ? {} : { aov }),
  };
}

type CloseIssue = (
  mcp: HostContext["mcp"],
  input: { identifier: string },
) => Promise<LinearCallResult>;

/**
 * Production close-out. Does not start a model turn. A recovery for an
 * incident that has not shipped is ignored.
 */
export async function handleProductionRecovery(
  host: HostContext,
  body: ObservabilityAlert,
  deps?: { closeIssue?: CloseIssue },
): Promise<RecoveryOutcome> {
  if (!isRecoveryStatus(body.status)) {
    return { closed: false, reason: "not_recovery" };
  }
  return serialize(`recover:${body.incidentId}`, () => recoverLocked(host, body, deps?.closeIssue));
}

async function recoverLocked(
  host: HostContext,
  body: ObservabilityAlert,
  closeIssue: CloseIssue | undefined,
): Promise<RecoveryOutcome> {
  if (!isProductionEnv(body.env)) {
    return { closed: false, reason: "not_production" };
  }
  const incident = await getIncident(host.kv, body.incidentId);
  if (incident === undefined) {
    return { closed: false, reason: "unknown_incident" };
  }
  if (incident.status === "closed" || incident.resolutionPostedAt !== undefined) {
    if (incident.status !== "closed") {
      await updateIncident(host.kv, incident.incidentId, { status: "closed" });
    }
    return { closed: true, already: true };
  }
  const shipped = await getShipped(host.kv, body.incidentId);
  if (shipped === undefined || incident.shippedAt === undefined) {
    return { closed: false, reason: "not_shipped" };
  }
  const readings = recoveryReadings(body);
  if (!readings.complete || readings.gmv === undefined || readings.aov === undefined) {
    return { closed: false, reason: "metrics_incomplete" };
  }
  if (!readings.recovered) {
    return { closed: false, reason: "not_recovered" };
  }
  const linearId = shipped.linearIssueId ?? incident.linearIssueId;
  const linearUrl = shipped.linearIssueUrl ?? incident.linearIssueUrl;
  let linear = "skipped";
  if (linearId !== undefined) {
    const closer = closeIssue ?? closeLinearIssue;
    const closed = await closer(host.mcp, { identifier: linearId });
    if (!closed.ok) {
      return { closed: false, reason: "linear_close_failed", message: closed.message, linear: "failed" };
    }
    linear = "closed";
  }
  const beforeGmv = readings.gmv.previous ?? beforeFromIncident(incident, GMV);
  const beforeAov = readings.aov.previous ?? beforeFromIncident(incident, AOV);
  const payload = productionResolvedPayload({
    incidentId: incident.incidentId,
    gmv: {
      after: readings.gmv.after,
      baseline: readings.gmv.baseline,
      ...(beforeGmv === undefined ? {} : { before: beforeGmv }),
    },
    aov: {
      after: readings.aov.after,
      baseline: readings.aov.baseline,
      ...(beforeAov === undefined ? {} : { before: beforeAov }),
    },
    ...(shipped.prUrl === undefined ? {} : { prUrl: shipped.prUrl }),
    prNumber: shipped.prNumber,
    ...(linearId === undefined ? {} : { linearIssueId: linearId }),
    ...(linearUrl === undefined ? {} : { linearIssueUrl: linearUrl }),
  });
  const text = scrubPublicText(payload.text);
  const posted = await postSlack({
    host,
    incident: {
      ...incident,
      slackThreadTs: incident.slackThreadTs ?? shipped.threadTs,
      ...(shipped.channelId === undefined ? {} : { slackChannelId: incident.slackChannelId ?? shipped.channelId }),
    },
    text,
    blocks: payload.blocks,
    thread: true,
  });
  if (!posted.posted) {
    return { closed: false, reason: posted.reason, linear };
  }
  await updateIncident(host.kv, incident.incidentId, {
    status: "closed",
    resolutionPostedAt: new Date().toISOString(),
    prNumber: shipped.prNumber,
    ...(shipped.prUrl === undefined ? {} : { prUrl: shipped.prUrl }),
    note: "Production metrics are back within 10% of baseline.",
  });
  if (linearId !== undefined) {
    const commented = await commentLinearIssue(host.mcp, { identifier: linearId, body: text });
    if (!commented.ok) {
      linear = `closed:${commented.message}`;
    }
  }
  await cancelWatches(host, incident);
  return { closed: true, linear };
}

function readingFor(
  point: ObservabilityAlert["gmv"],
  body: ObservabilityAlert,
  metric: string,
): Reading | undefined {
  if (point != null) {
    const after = point.value ?? point.current;
    if (after === undefined || point.baseline === undefined) {
      return undefined;
    }
    return {
      after,
      baseline: point.baseline,
      ...(point.previous === undefined ? {} : { previous: point.previous }),
    };
  }
  if (body.metric === metric) {
    return { after: body.value, baseline: body.baseline };
  }
  return undefined;
}

function beforeFromIncident(incident: IncidentRecord, metric: string): number | undefined {
  return incident.metric === metric ? incident.value : undefined;
}

async function cancelWatches(host: HostContext, incident: IncidentRecord): Promise<void> {
  if (host.reminders === undefined) {
    return;
  }
  try {
    if (incident.previewReminderId !== undefined) {
      await host.reminders.cancel(incident.previewReminderId, "production recovered");
    }
    if (incident.signoffReminderId !== undefined) {
      await host.reminders.cancel(incident.signoffReminderId, "production recovered");
    }
    await host.reminders.cancelForContinuation(
      incidentContinuation(incident.incidentId),
      "production recovered",
    );
  } catch (error) {
    console.warn(
      `[spike-detector] reminder cancel failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
