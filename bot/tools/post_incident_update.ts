import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { announceKnownPullRequest } from "../lib/cloud-stop.js";
import { INCIDENT_ID_PATTERN } from "../lib/demo.js";
import { getIncident } from "../lib/incidents.js";
import { commentIncident } from "../lib/notify.js";
import { extractPrUrl } from "../lib/public-text.js";

export default defineTool({
  description:
    "Post a progress note to the incident's Slack thread and Linear issue. A pull request URL is announced once. A repeat of the triage card or the fix-in-progress line is ignored. Does not close the ticket.",
  effect: "write",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
    text: z.string().min(1).max(3000),
  }),
  dryRunResult: ({ incidentId }) => ({ posted: false, reason: "dry_run", incidentId }),
  async execute({ incidentId, text }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { posted: false, reason: "eval" };
    }
    const incident = await getIncident(ctx.host.kv, incidentId);
    if (incident === undefined) {
      return { posted: false, reason: "unknown_incident" };
    }
    const prUrl = extractPrUrl(text);
    if (prUrl !== undefined) {
      return announceKnownPullRequest(ctx.host, incidentId, prUrl);
    }
    if (incident.triageSlackTs !== undefined && /triage result/i.test(text)) {
      return { posted: true, already: true, slack: "already", linear: "skipped" };
    }
    if (incident.fixProgressPostedAt !== undefined && /fix in progress/i.test(text)) {
      return { posted: true, already: true, slack: "already", linear: "skipped" };
    }
    if (incident.shipReviewSlackTs !== undefined && /fix is ready for review/i.test(text)) {
      return { posted: true, already: true, slack: "already", linear: "skipped" };
    }
    if (incident.shippingPostedAt !== undefined && /shipping to production/i.test(text)) {
      return { posted: true, already: true, slack: "already", linear: "skipped" };
    }
    const result = await commentIncident(ctx.host, incident, text);
    return { posted: true, ...result };
  },
});
