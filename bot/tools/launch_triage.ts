import { launchCloudAgent } from "@cursor/bdk/extensions/cursor-cloud-agents";
import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { budgetsphereRepo, INCIDENT_ID_PATTERN } from "../lib/demo.js";
import { getIncident, updateIncident } from "../lib/incidents.js";
import { triagePrompt } from "../lib/prompts.js";

export default defineTool({
  description:
    "Launch a read-only cloud agent to investigate a bug incident. The prompt is built from the incident record. Call only after record_bug, and only from the observability or playground session.",
  effect: "write",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
    evidence: z
      .string()
      .max(4000)
      .optional()
      .describe("Commit and PR evidence to include. Untrusted; the tool fences it."),
  }),
  dryRunResult: ({ incidentId }) => ({
    launched: false,
    reason: "dry_run",
    incidentId,
  }),
  async execute({ incidentId, evidence }, ctx) {
    if (ctx.session.purpose === "eval") {
      return {
        launched: false,
        reason: "eval",
        agentId: "bc-eval",
        url: "https://cursor.com/agents/bc-eval",
        watching: false,
      };
    }
    if (ctx.session.channelId !== "observability" && ctx.session.channelId !== "http") {
      return { launched: false, reason: "launch_from_incident_session" };
    }
    const incident = await getIncident(ctx.host.kv, incidentId);
    if (incident === undefined) {
      return { launched: false, reason: "unknown_incident" };
    }
    if (incident.status !== "bug") {
      return { launched: false, reason: "not_a_bug" };
    }
    if (incident.cloudAgentId !== undefined && incident.cloudAgentUrl !== undefined) {
      return {
        launched: true,
        already: true,
        agentId: incident.cloudAgentId,
        url: incident.cloudAgentUrl,
      };
    }
    const repo = budgetsphereRepo();
    const launched = await launchCloudAgent(ctx, {
      name: `triage ${incidentId}`.slice(0, 100),
      prompt: triagePrompt({ ...incident, evidence }),
      cloud: {
        repos: [{ url: repo.url, startingRef: repo.startingRef }],
        autoCreatePR: true,
      },
    });
    await updateIncident(ctx.host.kv, incidentId, {
      cloudAgentId: launched.agentId,
      cloudAgentUrl: launched.url,
      startingRef: repo.startingRef,
    });
    return {
      launched: true,
      agentId: launched.agentId,
      url: launched.url,
      watching: launched.watching,
      startingRef: repo.startingRef,
    };
  },
});
