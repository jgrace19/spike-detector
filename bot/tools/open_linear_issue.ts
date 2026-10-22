import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { demo, INCIDENT_ID_PATTERN, linearProjectName } from "../lib/demo.js";
import { getIncident, updateIncident } from "../lib/incidents.js";
import { openLinearIssue } from "../lib/linear.js";

export default defineTool({
  description:
    "Open a Linear issue in the fe-demo workspace. The project name is LINEAR_PROJECT, or FreshCart when that is unset. Idempotent per incidentId. Call after record_bug.",
  effect: "write",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
    title: z.string().min(1).max(120),
    summary: z.string().min(1).max(2000),
  }),
  dryRunResult: ({ incidentId }) => ({ opened: false, reason: "dry_run", incidentId }),
  async execute({ incidentId, title, summary }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { opened: false, reason: "eval", identifier: "EVAL-1" };
    }
    const incident = await getIncident(ctx.host.kv, incidentId);
    if (incident === undefined) {
      return { opened: false, reason: "unknown_incident" };
    }
    if (incident.status !== "bug") {
      return { opened: false, reason: "not_a_bug" };
    }
    if (incident.linearIssueId !== undefined) {
      return {
        opened: true,
        already: true,
        identifier: incident.linearIssueId,
        url: incident.linearIssueUrl,
      };
    }
    const description = [
      `incident:${incidentId}`,
      `Workspace: ${demo.linearWorkspace}`,
      `Project: ${linearProjectName()}`,
      `metric: ${incident.metric}`,
      `env: ${incident.env}`,
      `baseline: ${incident.baseline}`,
      `value: ${incident.value}`,
      `window: ${incident.window}`,
      "",
      summary,
    ].join("\n");
    const opened = await openLinearIssue(ctx.host.mcp, { title, description });
    if (!opened.ok) {
      return { opened: false, reason: opened.reason, message: opened.message, toolNames: opened.toolNames };
    }
    const identifier = opened.identifier ?? title;
    await updateIncident(ctx.host.kv, incidentId, {
      linearIssueId: identifier,
      linearIssueUrl: opened.url,
    });
    return {
      opened: true,
      identifier,
      url: opened.url,
      workspace: demo.linearWorkspace,
      project: linearProjectName(),
    };
  },
});
