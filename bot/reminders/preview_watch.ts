import { defineReminder } from "@cursor/bdk/reminders";
import { isDeployReady } from "../lib/deploy.js";
import { validationMetrics } from "../lib/demo.js";
import { getIncident } from "../lib/incidents.js";
import { checkValidationMetrics } from "../lib/metrics.js";

/** Stop a preview watch about 45 minutes after it is armed. */
export const PREVIEW_WATCH_DEADLINE_MS = 45 * 60 * 1000;

/**
 * Polls the same KV snapshots as `query_metrics`. Reminder handlers have no
 * `callTool` (see ReminderFireContext), so the follow-up turn is what calls
 * the tool before closing the incident.
 *
 * A tick does nothing until the preview is ready: CI on the pull request
 * succeeded, or the first `preview-<pr>` snapshot was stored. The watch
 * stops once the incident is closed, or once `args.deadline` has passed.
 */
export default defineReminder({
  async run({ args, followup, host, cancel }) {
    const incidentId = typeof args.incidentId === "string" ? args.incidentId : "";
    const env = typeof args.env === "string" ? args.env : "";
    const prNumber = typeof args.prNumber === "number" ? args.prNumber : undefined;
    if (incidentId === "" || env === "" || prNumber === undefined) {
      return { action: "stop" };
    }
    const incident = await getIncident(host.kv, incidentId);
    if (incident === undefined || incident.status === "closed") {
      await cancel("incident closed");
      return { action: "stop" };
    }
    const deadline = typeof args.deadline === "string" ? Date.parse(args.deadline) : Number.NaN;
    if (Number.isFinite(deadline) && Date.now() >= deadline) {
      await cancel("watch deadline");
      return { action: "stop" };
    }
    const ready = await isDeployReady(host.kv, incident, prNumber);
    if (!ready.ready) {
      return { action: "skip" };
    }
    const validation = await checkValidationMetrics(host.kv, env, incident);
    if (!validation.recovered) {
      return { action: "skip" };
    }
    const summary = validation.metrics
      .map((metric) => `${metric.metric} value ${metric.value} baseline ${metric.baseline}`)
      .join("; ");
    await followup({
      message: [
        `Preview poll for incident:${incidentId}.`,
        `Deploy ready via ${ready.reason} on env ${env} (pull request ${prNumber}).`,
        `${validationMetrics.join(" and ")} look recovered (${summary}).`,
        "Call query_metrics for each, then close_incident.",
        "Do not launch another cloud agent.",
      ].join(" "),
    });
    return { action: "delivered" };
  },
});
