import type { HostContext } from "@cursor/bdk";
import { incidentContinuation } from "./demo.js";
import {
  deleteIncident,
  getIncident,
  incidentIndexKey,
  listIncidentIds,
  type IncidentRecord,
} from "./incidents.js";
import { listShippedIds, shippedIndexKey, shippedKey } from "./shipped.js";

export type ResetResult = {
  ok: true;
  closed: string[];
  cleared: string[];
};

/**
 * Close every open incident, cancel its watches, and remove stored incident
 * records so the same id can be admitted again. Deletes every shipped record.
 */
export async function resetObservability(host: HostContext): Promise<ResetResult> {
  const closed: string[] = [];
  for (const incidentId of await listIncidentIds(host.kv)) {
    const incident = await getIncident(host.kv, incidentId);
    if (incident === undefined) {
      continue;
    }
    if (incident.status !== "closed") {
      await cancelIncidentReminders(host, incident);
    }
    await deleteIncident(host.kv, incidentId);
    closed.push(incidentId);
  }
  await host.kv.delete(incidentIndexKey());

  const cleared: string[] = [];
  for (const incidentId of await listShippedIds(host.kv)) {
    await host.kv.delete(shippedKey(incidentId));
    cleared.push(incidentId);
  }
  await host.kv.delete(shippedIndexKey());
  return { ok: true, closed, cleared };
}

async function cancelIncidentReminders(host: HostContext, incident: IncidentRecord): Promise<void> {
  if (host.reminders === undefined) {
    return;
  }
  try {
    if (incident.previewReminderId !== undefined) {
      await host.reminders.cancel(incident.previewReminderId, "incident closed");
    }
    if (incident.signoffReminderId !== undefined) {
      await host.reminders.cancel(incident.signoffReminderId, "incident closed");
    }
    await host.reminders.cancelForContinuation(
      incidentContinuation(incident.incidentId),
      "incident closed",
    );
  } catch (error) {
    console.warn(
      `[spike-detector] reminder cancel failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
