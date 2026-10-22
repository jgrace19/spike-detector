import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { isDeployReady } from "../lib/deploy.js";
import { incidentContinuation, INCIDENT_ID_PATTERN, previewEnv } from "../lib/demo.js";
import { getIncident, updateIncident } from "../lib/incidents.js";
import { closeLinearIssue } from "../lib/linear.js";
import { checkValidationMetrics } from "../lib/metrics.js";
import { commentIncident } from "../lib/notify.js";

export default defineTool({
  description:
    "After the preview is ready and both freshcart.checkout.gmv_cents and freshcart.checkout.average_order_value_cents are within 10% of baseline, comment on Slack and Linear, close the Linear issue, and cancel the reminder. Deploy ready means CI succeeded or the first preview-<pr> snapshot arrived.",
  effect: "write",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
    prNumber: z.number().int().positive(),
    note: z.string().min(1).max(2000),
  }),
  dryRunResult: ({ incidentId }) => ({ closed: false, reason: "dry_run", incidentId }),
  async execute({ incidentId, prNumber, note }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { closed: false, reason: "eval" };
    }
    const incident = await getIncident(ctx.host.kv, incidentId);
    if (incident === undefined) {
      return { closed: false, reason: "unknown_incident" };
    }
    if (incident.status === "closed") {
      return { closed: true, already: true };
    }
    const env = previewEnv(prNumber);
    const ready = await isDeployReady(ctx.host.kv, incident, prNumber);
    if (!ready.ready) {
      return { closed: false, reason: "deploy_not_ready", env };
    }
    const validation = await checkValidationMetrics(ctx.host.kv, env, incident);
    if (!validation.recovered) {
      return {
        closed: false,
        reason: "not_recovered",
        env,
        deployReady: ready.reason,
        metrics: validation.metrics,
      };
    }
    const lines = validation.metrics.map(
      (metric) => `${metric.metric}: value ${metric.value}, baseline ${metric.baseline}`,
    );
    const text = [`incident:${incidentId} recovered on ${env} (${ready.reason}).`, ...lines, note].join(
      "\n",
    );
    const comments = await commentIncident(ctx.host, incident, text);
    let linear = "skipped";
    if (incident.linearIssueId !== undefined) {
      const closed = await closeLinearIssue(ctx.host.mcp, { identifier: incident.linearIssueId });
      linear = closed.ok ? "closed" : closed.message;
      if (!closed.ok) {
        return { closed: false, reason: "linear_close_failed", message: closed.message, comments };
      }
    }
    if (ctx.host.reminders !== undefined) {
      if (incident.previewReminderId !== undefined) {
        await ctx.host.reminders.cancel(incident.previewReminderId, "metrics recovered");
      }
      if (incident.signoffReminderId !== undefined) {
        await ctx.host.reminders.cancel(incident.signoffReminderId, "incident closed");
      }
      await ctx.host.reminders.cancelForContinuation(
        incidentContinuation(incidentId),
        "incident closed",
      );
    }
    await updateIncident(ctx.host.kv, incidentId, {
      status: "closed",
      prNumber,
      note,
    });
    return { closed: true, env, deployReady: ready.reason, metrics: validation.metrics, comments, linear };
  },
});