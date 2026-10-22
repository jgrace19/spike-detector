import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { INCIDENT_ID_PATTERN } from "../lib/demo.js";
import { getIncident, updateIncident } from "../lib/incidents.js";
import { armSignoffWatch } from "../lib/watch.js";

export default defineTool({
  description:
    "Record that the alert is a bug. Call this before launch_triage, open_linear_issue, and page_code_owner. Does not page by itself.",
  effect: "write",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
    note: z.string().min(1).max(1000).describe("Why recent commits and PRs do not explain the spike."),
  }),
  dryRunResult: ({ incidentId }) => ({
    recorded: false,
    reason: "dry_run",
    decision: "bug" as const,
    incidentId,
  }),
  async execute({ incidentId, note }, ctx) {
    const incident = await getIncident(ctx.host.kv, incidentId);
    if (incident === undefined) {
      if (ctx.session.purpose === "eval") {
        return {
          recorded: true,
          reason: "eval",
          decision: "bug" as const,
          next: ["launch_triage", "open_linear_issue", "page_code_owner"] as const,
        };
      }
      return { recorded: false, reason: "unknown_incident", decision: "bug" as const };
    }
    if (incident.status === "expected") {
      return { recorded: false, reason: "already_expected", decision: "bug" as const };
    }
    if (incident.status === "closed") {
      return { recorded: false, reason: "already_closed", decision: "bug" as const };
    }
    if (incident.status !== "bug") {
      await updateIncident(ctx.host.kv, incidentId, { status: "bug", note });
    }
    const watch = await armSignoffWatch(ctx.host, incidentId);
    return {
      recorded: true,
      decision: "bug" as const,
      already: incident.status === "bug",
      signoffWatch: watch.armed ? watch.reminderId : watch.reason,
      next: ["launch_triage", "open_linear_issue", "page_code_owner"] as const,
    };
  },
});
