import { defineAgent } from "@cursor/bdk";

export default defineAgent({
  name: "spike-detector",
  description: "Classifies marketplace checkout anomalies and triages the ones that are bugs.",
  model: {
    id: "grok-4.5",
    params: [
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  },
  local: { sandbox: true },
  tools: ["read", "grep", "glob", "ls"],
  hosting: {
    egressDomains: ["mcp.linear.app"],
    secretNames: [
      "OBSERVABILITY_SHARED_SECRET",
      "SPIKE_DETECTOR_SLACK_CHANNEL",
      "SPIKE_DETECTOR_CODE_OWNER_SLACK_ID",
      "MARKETPLACE_STARTING_REF",
      "LINEAR_PROJECT",
      "LINEAR_TOKEN",
    ],
  },
});
