import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { INCIDENT_ID_PATTERN } from "../lib/demo.js";
import { getIncident, updateIncident } from "../lib/incidents.js";

export default defineTool({
  description:
    "Record that the alert matches an intentional change. Writes a note and does not page, open a ticket, or launch a cloud agent. Call only after list_recent_changes.",
  effect: "write",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
    note: z.string().min(1).max(1000).describe("Which commit or PR explains the change."),
  }),
  dryRunResult: ({ incidentId, note }) => ({
    logged: false,
    reason: "dry_run",
    decision: "expected" as const,
    incidentId,
    note,
  }),
  async execute({ incidentId, note }, ctx) {
    const incident = await getIncident(ctx.host.kv, incidentId);
    if (incident === undefined) {
      if (ctx.session.purpose === "eval") {
        return { logged: true, reason: "eval", decision: "expected" as const, note };
      }
      return { logged: false, reason: "unknown_incident", decision: "expected" as const };
    }
    if (incident.status === "bug" || incident.status === "closed") {
      return {
        logged: false,
        reason: "already_" + incident.status,
        decision: "expected" as const,
      };
    }
    if (incident.status === "expected") {
      return { logged: true, already: true, decision: "expected" as const, note: incident.note };
    }
    await updateIncident(ctx.host.kv, incidentId, { status: "expected", note });
    return { logged: true, decision: "expected" as const, note };
  },
});
