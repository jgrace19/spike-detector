import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { INCIDENT_ID_PATTERN } from "../lib/demo.js";
import { getIncident, type IncidentRecord } from "../lib/incidents.js";

export default defineTool({
  description:
    "Load the persisted incident record for this incidentId. Slack and GitHub sessions use this to resume an alert that started on the observability channel.",
  effect: "read",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
  }),
  async execute({ incidentId }, ctx) {
    const incident = await getIncident(ctx.host.kv, incidentId);
    if (incident === undefined) {
      return { found: false as const, incidentId };
    }
    return { found: true as const, incident: publicIncident(incident) };
  },
});

function publicIncident(incident: IncidentRecord): Omit<IncidentRecord, "principal"> {
  const { principal: _principal, ...rest } = incident;
  return rest;
}
