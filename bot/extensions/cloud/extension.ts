import cursorCloudAgents from "@cursor/bdk/extensions/cursor-cloud-agents";
import { budgetsphereRepo } from "../../lib/demo.js";

/**
 * `cloud__launch` and `cloud__reply` are disabled. Authored tools build the
 * prompts and enforce the sign-off gate. `repos` is a function so
 * BUDGETSPHERE_STARTING_REF is read on each launch, after hosted secrets
 * are available.
 */
export default cursorCloudAgents({
  needsApproval: false,
  watchStops: true,
  channels: ["observability", "slack", "github", "http"],
  cloud: {
    autoCreatePR: true,
    repos: () => [budgetsphereRepo()],
  },
});
