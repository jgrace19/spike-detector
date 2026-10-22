import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { listChanges } from "../lib/changes.js";
import { INCIDENT_ID_PATTERN } from "../lib/demo.js";

export default defineTool({
  description:
    "Read recent commits and pull requests in jgrace19/marketplace. Call this before classifying an alert. A GitHub failure is ok:false — do not treat that as an empty history.",
  effect: "read",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
    window: z.string().describe("Alert window such as 30m, 2h, or 1d."),
  }),
  async execute({ incidentId, window }, ctx) {
    return listChanges({
      incidentId,
      window,
      purpose: ctx.session.purpose,
      github: ctx.host.github,
    });
  },
});
