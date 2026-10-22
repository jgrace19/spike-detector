import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod";
import { INCIDENT_ID_PATTERN } from "../lib/demo.js";
import { getRecoveryRecord, handleProductionRecovery } from "../lib/recovery.js";

export default defineTool({
  description:
    "Finish a production close-out after a recovered observability push whose automatic close-out did not complete. Replays the last recorded recovery: posts the Slack resolution once, marks the Linear issue done, and adds the resolved comment. Use only when a message asks for it.",
  effect: "write",
  inputSchema: z.object({
    incidentId: z.string().regex(INCIDENT_ID_PATTERN),
  }),
  dryRunResult: ({ incidentId }) => ({ closed: false, reason: "dry_run", incidentId }),
  async execute({ incidentId }, ctx) {
    if (ctx.session.purpose === "eval") {
      return { closed: false, reason: "eval" };
    }
    const record = await getRecoveryRecord(ctx.host.kv, incidentId);
    if (record === undefined) {
      return { closed: false, reason: "no_recovery_recorded" };
    }
    return handleProductionRecovery(ctx.host, record.body, { via: "turn" });
  },
});
