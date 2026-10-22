import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { getIncident } from "../lib/incidents.js";
import { INCIDENT_ID_PATTERN } from "../lib/demo.js";
import { isRecovered, latestSnapshot } from "../lib/metrics.js";

export default defineTool({
  description:
    "Read the latest metric snapshot stored by POST /metrics. For a fix pull request, pass env preview-<pr number>. recovered is true when the value is within 10% of baseline.",
  effect: "read",
  inputSchema: z.object({
    metric: z.string().min(1),
    env: z.string().min(1),
    incidentId: z.string().regex(INCIDENT_ID_PATTERN).optional(),
  }),
  async execute({ metric, env, incidentId }, ctx) {
    const snapshot = await latestSnapshot(ctx.host.kv, env, metric);
    const incident =
      incidentId === undefined ? undefined : await getIncident(ctx.host.kv, incidentId);
    if (snapshot === undefined) {
      return {
        found: false as const,
        metric,
        env,
        recovered: false,
        baseline: incident?.baseline,
      };
    }
    const baseline = snapshot.baseline ?? incident?.baseline;
    return {
      found: true as const,
      metric,
      env,
      value: snapshot.value,
      baseline,
      at: snapshot.at,
      recovered: baseline === undefined ? false : isRecovered(snapshot.value, baseline),
    };
  },
});
