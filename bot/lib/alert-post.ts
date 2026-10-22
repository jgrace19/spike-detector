import type { HostContext } from "@cursor/bdk";
import { getIncident, updateIncident, type IncidentRecord } from "./incidents.js";
import { postSlack, updateSlack } from "./notify.js";
import { alertPayload } from "./slack-cards.js";

/**
 * Post the alert, or refresh the same message once Linear or the cloud
 * agent link exists. Never posts a second root message.
 */
export async function postOrUpdateAlert(
  host: HostContext,
  incident: IncidentRecord,
): Promise<{ posted: true; channel: string; ts: string; updated?: boolean } | { posted: false; reason: string }> {
  const latest = (await getIncident(host.kv, incident.incidentId)) ?? incident;
  const payload = alertPayload(latest);
  if (latest.slackThreadTs !== undefined && latest.slackChannelId !== undefined) {
    const updated = await updateSlack({
      host,
      channel: latest.slackChannelId,
      ts: latest.slackThreadTs,
      text: payload.text,
      blocks: payload.blocks,
    });
    if (!updated.updated) {
      return { posted: true, channel: latest.slackChannelId, ts: latest.slackThreadTs, updated: false };
    }
    return { posted: true, channel: latest.slackChannelId, ts: latest.slackThreadTs, updated: true };
  }
  const posted = await postSlack({
    host,
    incident: latest,
    text: payload.text,
    blocks: payload.blocks,
    role: "alert",
  });
  if (!posted.posted) {
    return posted;
  }
  await updateIncident(host.kv, latest.incidentId, {
    slackChannelId: posted.channel,
    slackThreadTs: posted.ts,
  });
  return posted;
}

export async function refreshAlertIfPosted(host: HostContext, incidentId: string): Promise<void> {
  const incident = await getIncident(host.kv, incidentId);
  if (incident?.slackThreadTs === undefined) {
    return;
  }
  await postOrUpdateAlert(host, incident);
}
