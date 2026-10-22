import { defineReminder } from "@cursor/bdk/reminders";
import { getIncident } from "../lib/incidents.js";
import { isRecovered, latestSnapshot } from "../lib/metrics.js";

/**
 * Polls the same KV snapshots as `query_metrics`. Reminder handlers have no
 * `callTool` (see ReminderFireContext), so the follow-up turn is what calls
 * the tool before closing the incident.
 */
export default defineReminder({
  async run({ args, followup, host, cancel }) {
    const incidentId = typeof args.incidentId === "string" ? args.incidentId : "";
    const metric = typeof args.metric === "string" ? args.metric : "";
    const env = typeof args.env === "string" ? args.env : "";
    const prNumber = typeof args.prNumber === "number" ? args.prNumber : undefined;
    if (incidentId === "" || metric === "" || env === "") {
      return { action: "stop" };
    }
    const incident = await getIncident(host.kv, incidentId);
    if (incident === undefined || incident.status === "closed") {
      await cancel("incident closed");
      return { action: "stop" };
    }
    const snapshot = await latestSnapshot(host.kv, env, metric);
    const baseline = snapshot?.baseline ?? incident.baseline;
    if (snapshot === undefined || !isRecovered(snapshot.value, baseline)) {
      return { action: "skip" };
    }
    await followup({
      message: [
        `Preview poll for incident:${incidentId}.`,
        `query_metrics env ${env} metric ${metric} looks recovered`,
        `(value ${snapshot.value}, baseline ${baseline}, pr ${prNumber ?? "unknown"}).`,
        "Call query_metrics to confirm, then close_incident.",
        "Do not launch another cloud agent.",
      ].join(" "),
    });
    return { action: "delivered" };
  },
});
