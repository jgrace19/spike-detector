import type { HostContext, ReminderDefinition, ReminderInfo } from "@cursor/bdk";
import { linkPullRequest } from "./deploy.js";
import { incidentContinuation, previewEnv } from "./demo.js";
import { getIncident, putIncident } from "./incidents.js";
import previewWatch from "../reminders/preview_watch.js";
import signoffWatch from "../reminders/signoff_watch.js";

export async function armSignoffWatch(
  host: HostContext,
  incidentId: string,
): Promise<{ armed: true; reminderId: string } | { armed: false; reason: string }> {
  return arm(host, {
    incidentId,
    purpose: `signoff:${incidentId}`,
    field: "signoffReminderId",
    every: "1m",
    handler: signoffWatch,
    args: { incidentId },
  });
}

export async function armPreviewWatch(
  host: HostContext,
  input: { incidentId: string; prNumber: number; metric: string },
): Promise<{ armed: true; reminderId: string } | { armed: false; reason: string }> {
  const incident = await getIncident(host.kv, input.incidentId);
  if (incident === undefined) {
    return { armed: false, reason: "unknown_incident" };
  }
  const updated = {
    ...incident,
    prNumber: input.prNumber,
    updatedAt: new Date().toISOString(),
  };
  await putIncident(host.kv, updated);
  await linkPullRequest(host.kv, input.incidentId, input.prNumber);
  return arm(host, {
    incidentId: input.incidentId,
    purpose: `preview:${input.incidentId}`,
    field: "previewReminderId",
    every: "5m",
    handler: previewWatch,
    args: {
      incidentId: input.incidentId,
      prNumber: input.prNumber,
      metric: input.metric,
      env: previewEnv(input.prNumber),
    },
  });
}

async function arm(
  host: HostContext,
  input: {
    incidentId: string;
    purpose: string;
    field: "signoffReminderId" | "previewReminderId";
    every: string;
    handler: ReminderDefinition;
    args: Record<string, string | number>;
  },
): Promise<{ armed: true; reminderId: string } | { armed: false; reason: string }> {
  if (host.reminders === undefined) {
    return { armed: false, reason: "reminders_unavailable" };
  }
  const incident = await getIncident(host.kv, input.incidentId);
  if (incident === undefined) {
    return { armed: false, reason: "unknown_incident" };
  }
  const existingId = incident[input.field];
  if (existingId !== undefined) {
    const existing = await host.reminders.list({ purpose: input.purpose, status: "armed" });
    if (existing.some((reminder) => reminder.id === existingId)) {
      return { armed: true, reminderId: existingId };
    }
  }
  let created: ReminderInfo;
  try {
    created = await host.reminders.create({
      purpose: input.purpose,
      channelId: "observability",
      continuationToken: incidentContinuation(input.incidentId),
      every: input.every,
      handler: input.handler,
      args: input.args,
    });
  } catch (error) {
    return { armed: false, reason: error instanceof Error ? error.message : String(error) };
  }
  await putIncident(host.kv, {
    ...incident,
    [input.field]: created.id,
    updatedAt: new Date().toISOString(),
  });
  return { armed: true, reminderId: created.id };
}
