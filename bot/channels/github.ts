import { defaultGitHubAuth, githubChannel } from "@cursor/bdk/channels/github";
import { demo } from "../lib/demo.js";
import { getIncident } from "../lib/incidents.js";
import { armPreviewWatch } from "../lib/watch.js";

const WATCH_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review", "closed"]);
const INCIDENT_IN_TEXT = /incident:([A-Za-z0-9][A-Za-z0-9._:-]{0,119})/;

export default githubChannel({
  botName: "spike-detector",
  cursorAccount: {
    repos: [`${demo.owner}/${demo.repo}`],
    permissions: "read",
  },
  onPullRequest: async (ctx, pr) => {
    const incidentId = `${pr.title}\n${pr.body ?? ""}`.match(INCIDENT_IN_TEXT)?.[1];
    if (incidentId === undefined || !WATCH_ACTIONS.has(pr.action)) {
      return null;
    }
    const incident = await getIncident(ctx.host.kv, incidentId);
    if (incident === undefined || incident.status === "closed" || incident.status === "expected") {
      return null;
    }
    await armPreviewWatch(ctx.host, {
      incidentId,
      prNumber: pr.number,
      metric: incident.metric,
    });
    return {
      auth: defaultGitHubAuth(ctx),
      title: `Preview incident:${incidentId}`,
      message: [
        `GitHub ${pr.action} on ${pr.url} for incident:${incidentId}.`,
        `Call query_metrics with metric "${incident.metric}" and env "preview-${pr.number}".`,
        "If recovered is true, call close_incident with that pull request number.",
        "If recovered is false, leave the preview reminder armed.",
        "Do not launch a cloud agent from this session.",
      ].join("\n"),
    };
  },
});
