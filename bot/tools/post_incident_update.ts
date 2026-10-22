import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { INCIDENT_ID_PATTERN } from "../lib/demo.js";
import { getIncident } from "../lib/incidents.js";
import { commentIncident } from "../lib/notify.js";

export default defineTool({
  description:
    "Post a progress note to the incident's Slack thread and Linear issue. Use when triage finishes or the fix PR opens. Does not close the ticket.",
  effect: "write",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
    text: z.string().min(1).max(3000),
  }),
  dryRunResult: ({ incidentId }) => ({ posted: false, reason: "dry_run", incidentId }),
  async execute({ incidentId, text }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { posted: false, reason: "eval" };
    }
    const incident = await getIncident(ctx.host.kv, incidentId);
    if (incident === undefined) {
      return { posted: false, reason: "unknown_incident" };
    }
    const result = await commentIncident(ctx.host, incident, text);
    return { posted: true, ...result };
  },
});
