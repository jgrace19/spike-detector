import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { incidentContinuation, INCIDENT_ID_PATTERN, previewEnv } from "../lib/demo.js";
import { getIncident, updateIncident } from "../lib/incidents.js";
import { closeLinearIssue } from "../lib/linear.js";
import { isRecovered, latestSnapshot } from "../lib/metrics.js";
import { commentIncident } from "../lib/notify.js";

export default defineTool({
  description:
    "After query_metrics shows the preview metric back at baseline, comment on Slack and Linear, close the Linear issue, and cancel the preview reminder. Refuses to close while the metric is still elevated.",
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
    const snapshot = await latestSnapshot(ctx.host.kv, env, incident.metric);
    const baseline = snapshot?.baseline ?? incident.baseline;
    if (snapshot === undefined || !isRecovered(snapshot.value, baseline)) {
      return {
        closed: false,
        reason: "not_recovered",
        env,
        value: snapshot?.value,
        baseline,
      };
    }
    const text = [
      `incident:${incidentId} recovered.`,
      `metric ${incident.metric} in ${env}: value ${snapshot.value}, baseline ${baseline}.`,
      note,
    ].join("\n");
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
        await ctx.host.reminders.cancel(incident.previewReminderId, "metric recovered");
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
    return { closed: true, env, value: snapshot.value, baseline, comments, linear };
  },
});
