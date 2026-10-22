import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { INCIDENT_ID_PATTERN, previewEnv } from "../lib/demo.js";
import { getIncident } from "../lib/incidents.js";
import { armPreviewWatch } from "../lib/watch.js";

export default defineTool({
  description:
    "Arm a reminder that polls preview-<pr> metrics until the alert metric returns to baseline. Idempotent per incident. Pass the pull request number from the cloud agent or the GitHub event, never an invented number.",
  effect: "write",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
    prNumber: z.number().int().positive(),
  }),
  dryRunResult: ({ incidentId, prNumber }) => ({
    armed: false,
    reason: "dry_run",
    incidentId,
    prNumber,
  }),
  async execute({ incidentId, prNumber }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { armed: false, reason: "eval", env: previewEnv(prNumber) };
    }
    const incident = await getIncident(ctx.host.kv, incidentId);
    if (incident === undefined) {
      return { armed: false, reason: "unknown_incident" };
    }
    const armed = await armPreviewWatch(ctx.host, {
      incidentId,
      prNumber,
      metric: incident.metric,
    });
    if (!armed.armed) {
      return { armed: false, reason: armed.reason, env: previewEnv(prNumber) };
    }
    return { armed: true, reminderId: armed.reminderId, env: previewEnv(prNumber) };
  },
});
