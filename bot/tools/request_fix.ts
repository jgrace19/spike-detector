import { followUpCloudAgent } from "@cursor/bdk/extensions/cursor-cloud-agents";
import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { INCIDENT_ID_PATTERN } from "../lib/demo.js";
import { getIncident, updateIncident } from "../lib/incidents.js";
import { fixPrompt } from "../lib/prompts.js";

export default defineTool({
  description:
    "After a recorded Slack sign-off, tell the existing cloud agent to implement the fix and open a PR. Does not launch a second agent. Call from the incident session, not from Slack.",
  effect: "write",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
    plan: z
      .string()
      .max(4000)
      .optional()
      .describe("Proposed fix from the triage report. Fenced as untrusted."),
  }),
  dryRunResult: ({ incidentId }) => ({ requested: false, reason: "dry_run", incidentId }),
  async execute({ incidentId, plan }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { requested: false, reason: "eval" };
    }
    if (ctx.session.channelId !== "observability" && ctx.session.channelId !== "http") {
      return { requested: false, reason: "incident_session_required" };
    }
    const incident = await getIncident(ctx.host.kv, incidentId);
    if (incident === undefined) {
      return { requested: false, reason: "unknown_incident" };
    }
    if (incident.signedOffAt === undefined || incident.signedOffNote === undefined) {
      return { requested: false, reason: "not_signed_off" };
    }
    if (incident.cloudAgentId === undefined) {
      return { requested: false, reason: "no_cloud_agent" };
    }
    if (incident.fixRequestedAt !== undefined) {
      return { requested: true, already: true, agentId: incident.cloudAgentId };
    }
    await updateIncident(ctx.host.kv, incidentId, { fixRequestedAt: new Date().toISOString() });
    try {
      const result = await followUpCloudAgent(ctx, {
        agentId: incident.cloudAgentId,
        prompt: fixPrompt({
          incidentId,
          signoffNote: incident.signedOffNote,
          plan,
        }),
      });
      return {
        requested: true,
        agentId: incident.cloudAgentId,
        runId: result.runId,
        watching: result.watching,
      };
    } catch (error) {
      await updateIncident(ctx.host.kv, incidentId, { fixRequestedAt: undefined });
      return {
        requested: false,
        reason: "follow_up_failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
