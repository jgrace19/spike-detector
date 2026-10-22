import { defineReminder } from "@cursor/bdk/reminders";
import { getIncident } from "../lib/incidents.js";
import { signoffWakePrompt } from "../lib/prompts.js";

/**
 * Backup wake for the incident session when Slack sign-off cannot `send`
 * into it. The handler does not call tools: ReminderFireContext has
 * followup, cancel, and host, and no callTool.
 */
export default defineReminder({
  async run({ args, followup, host }) {
    const incidentId = typeof args.incidentId === "string" ? args.incidentId : "";
    if (incidentId === "") {
      return { action: "stop" };
    }
    const incident = await getIncident(host.kv, incidentId);
    if (
      incident === undefined ||
      incident.status === "closed" ||
      incident.fixRequestedAt !== undefined ||
      incident.signoffWakeSent === true
    ) {
      return { action: "stop" };
    }
    if (incident.signedOffAt === undefined) {
      return { action: "skip" };
    }
    await followup({ message: signoffWakePrompt(incidentId) });
    return { action: "stop" };
  },
});
