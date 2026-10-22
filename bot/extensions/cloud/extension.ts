import cursorCloudAgents from "@cursor/bdk/extensions/cursor-cloud-agents";
import { budgetsphereRepo } from "../../lib/demo.js";

/**
 * `cloud__launch` and `cloud__reply` are disabled. Authored tools build the
 * prompts and enforce the sign-off gate. `repos` is a function so
 * BUDGETSPHERE_STARTING_REF is read on each launch, after hosted secrets
 * are available. The default ref is `demo/base`. Fix pull requests
 * target that same ref. The launch API has `startingRef` and
 * `autoCreatePR`, and no separate pull-request base field, so
 * `request_fix` names the base branch in the follow-up.
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
