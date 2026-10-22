import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { postOrUpdateAlert } from "../lib/alert-post.js";
import { INCIDENT_ID_PATTERN } from "../lib/demo.js";
import { getIncident } from "../lib/incidents.js";

export default defineTool({
  description:
    "Post the incident alert in Slack: metric, value versus baseline, percent change, environment, window, and that triage is underway. Includes the Linear link and cloud agent link when those already exist. Does not ask for sign-off and does not @mention anyone. Idempotent; a later call updates the same message. Call after record_bug, launch_triage, and open_linear_issue.",
  effect: "write",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
    summary: z
      .string()
      .max(1000)
      .optional()
      .describe("Ignored. The alert is rendered from the incident record."),
  }),
  dryRunResult: ({ incidentId }) => ({ posted: false, reason: "dry_run", incidentId }),
  async execute({ incidentId }, ctx) {
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
    const posted = await postOrUpdateAlert(ctx.host, incident);
    if (!posted.posted) {
      return posted;
    }
    return {
      posted: true,
      channel: posted.channel,
      ts: posted.ts,
      ...(posted.updated === undefined ? {} : { updated: posted.updated }),
    };
  },
});
