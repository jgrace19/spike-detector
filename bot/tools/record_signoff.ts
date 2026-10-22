import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { INCIDENT_ID_PATTERN, incidentContinuation } from "../lib/demo.js";
import { getIncident, updateIncident } from "../lib/incidents.js";
import { signoffWakePrompt } from "../lib/prompts.js";

export default defineTool({
  description:
    "Record an explicit human sign-off from the Slack thread. Only a Slack session can call this. Wakes the incident session so it can call request_fix.",
  effect: "write",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
    note: z.string().min(1).max(1000).describe("The human's sign-off, in their words."),
  }),
  dryRunResult: ({ incidentId }) => ({ recorded: false, reason: "dry_run", incidentId }),
  async execute({ incidentId, note }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { recorded: false, reason: "eval" };
    }
    if (ctx.session.channelId !== "slack") {
      return { recorded: false, reason: "slack_session_required" };
    }
    const incident = await getIncident(ctx.host.kv, incidentId);
    if (incident === undefined) {
      return { recorded: false, reason: "unknown_incident" };
    }
    if (incident.status !== "bug") {
      return { recorded: false, reason: "not_a_bug" };
    }
    if (incident.signedOffAt !== undefined && incident.fixRequestedAt !== undefined) {
      return { recorded: true, already: true };
    }
    const signedOffAt = incident.signedOffAt ?? new Date().toISOString();
    const signedOffNote = incident.signedOffNote ?? note;
    await updateIncident(ctx.host.kv, incidentId, {
      signedOffAt,
      signedOffNote,
      signoffWakeSent: false,
    });
    try {
      await ctx.send("observability", signoffWakePrompt(incidentId), {
        continuationToken: incidentContinuation(incidentId),
        admission: "coalesce",
        ...(incident.principal === undefined ? {} : { auth: incident.principal }),
      });
      await updateIncident(ctx.host.kv, incidentId, { signoffWakeSent: true });
      return { recorded: true, wake: "incident_session" };
    } catch (error) {
      return {
        recorded: true,
        wake: "reminder",
        todo: "ctx.send into the incident continuation failed. The signoff_watch reminder is the fallback. Confirm whether tool send() can resume another channel's session as the stored principal.",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
