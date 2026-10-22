import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { INCIDENT_ID_PATTERN } from "../lib/demo.js";
import { getIncident, updateIncident } from "../lib/incidents.js";
import { pageText, postSlack } from "../lib/notify.js";

export default defineTool({
  description:
    "Ping the configured code owner in Slack and ask for sign-off in the thread. Stores the thread timestamp on the incident so a later Slack session can resume it. Call after record_bug.",
  effect: "write",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
    summary: z.string().max(1000).optional(),
  }),
  dryRunResult: ({ incidentId }) => ({ posted: false, reason: "dry_run", incidentId }),
  async execute({ incidentId, summary }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { posted: false, reason: "eval" };
    }
    const incident = await getIncident(ctx.host.kv, incidentId);
    if (incident === undefined) {
      return { posted: false, reason: "unknown_incident" };
    }
    if (incident.status !== "bug") {
      return { posted: false, reason: "not_a_bug" };
    }
    if (incident.slackThreadTs !== undefined && incident.slackChannelId !== undefined) {
      return {
        posted: true,
        already: true,
        channel: incident.slackChannelId,
        ts: incident.slackThreadTs,
      };
    }
    const posted = await postSlack({
      host: ctx.host,
      incident,
      text: pageText(incident, summary ?? ""),
    });
    if (!posted.posted) {
      return posted;
    }
    await updateIncident(ctx.host.kv, incidentId, {
      slackChannelId: posted.channel,
      slackThreadTs: posted.ts,
    });
    return { posted: true, channel: posted.channel, ts: posted.ts };
  },
});
