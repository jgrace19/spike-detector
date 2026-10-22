import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { publishCloudStop } from "../lib/cloud-stop.js";
import { INCIDENT_ID_PATTERN } from "../lib/demo.js";

export default defineTool({
  description:
    "Post the Slack triage card, or the fix pull request link, after the cloud agent has stopped. The stop hook posts the same update. Idempotent. Call from the incident session when a message starts with [cloud agent stopped]. Do not call it on the alert turn.",
  effect: "write",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
  }),
  dryRunResult: ({ incidentId }) => ({ posted: false, reason: "dry_run", incidentId }),
  async execute({ incidentId }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { posted: false, reason: "eval" };
    }
    if (ctx.session.channelId !== "observability" && ctx.session.channelId !== "http") {
      return { posted: false, reason: "incident_session_required" };
    }
    return publishCloudStop({ host: ctx.host, incidentId });
  },
});
