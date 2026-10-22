import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { incidentContinuation, INCIDENT_ID_PATTERN } from "../lib/demo.js";
import { getIncident } from "../lib/incidents.js";
import { isApprovalReply } from "../lib/public-text.js";
import { signoffWakePrompt } from "../lib/prompts.js";
import { applySignoff } from "../lib/signoff.js";

export default defineTool({
  description:
    "Record an explicit human sign-off from the Slack thread. The Slack handlers do this themselves for a triage-message reaction, Approve button, or approve reply, and they do not start a model turn. Calling this again returns already and does not wake the incident session a second time. Only a Slack session can call this.",
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
    if (!isApprovalReply(note) && !/^approved with\b/i.test(note)) {
      return { recorded: false, reason: "not_signoff" };
    }
    const result = await applySignoff({
      host: ctx.host,
      incidentId,
      note,
      wake: async (id) => {
        const incident = await getIncident(ctx.host.kv, id);
        await ctx.send("observability", signoffWakePrompt(id), {
          continuationToken: incidentContinuation(id),
          admission: "coalesce",
          ...(incident?.principal === undefined ? {} : { auth: incident.principal }),
        });
      },
    });
    if (result.status === "rejected") {
      return { recorded: false, reason: result.reason };
    }
    if (result.status === "already") {
      return { recorded: true, already: true };
    }
    return { recorded: true, wake: result.wake === "sent" ? "incident_session" : "reminder" };
  },
});
