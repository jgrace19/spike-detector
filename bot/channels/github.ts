import { defaultGitHubAuth, githubChannel } from "@cursor/bdk/channels/github";
import { incidentIdForPullRequest, markCiSuccess } from "../lib/deploy.js";
import { demo, validationMetrics } from "../lib/demo.js";
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
      message: previewMessage(incidentId, pr.number, pr.action, pr.url),
    };
  },
  onCheckSuite: async (ctx, suite) => {
    if (suite.conclusion !== "success" || suite.pullRequests.length === 0) {
      return null;
    }
    await markCiSuccess(
      ctx.host.kv,
      suite.pullRequests.map((pullRequest) => pullRequest.number),
    );
    const wake = await wakeForChecks(ctx.host.kv, suite.pullRequests);
    if (wake === null) {
      return null;
    }
    return { auth: defaultGitHubAuth(ctx), title: wake.title, message: wake.message };
  },
  onCheckRun: async (ctx, run) => {
    if (run.conclusion !== "success" || run.pullRequests.length === 0) {
      return null;
    }
    await markCiSuccess(
      ctx.host.kv,
      run.pullRequests.map((pullRequest) => pullRequest.number),
    );
    return null;
  },
});

async function wakeForChecks(
  kv: Parameters<typeof incidentIdForPullRequest>[0],
  pullRequests: readonly { number: number; url?: string }[],
): Promise<{ title: string; message: string } | null> {
  const pullRequest = pullRequests[0];
  if (pullRequest === undefined) {
    return null;
  }
  const incidentId = await incidentIdForPullRequest(kv, pullRequest.number);
  if (incidentId === undefined) {
    return null;
  }
  const incident = await getIncident(kv, incidentId);
  if (incident === undefined || incident.status === "closed") {
    return null;
  }
  return {
    title: `CI incident:${incidentId}`,
    message: [
      `GitHub check suite succeeded for pull request #${pullRequest.number}.`,
      "That marks the preview deploy ready. A deployment-host URL is not required.",
      previewMessage(incidentId, pullRequest.number, "ci_success", pullRequest.url ?? ""),
    ].join("\n"),
  };
}

function previewMessage(incidentId: string, prNumber: number, action: string, url: string): string {
  return [
    `GitHub ${action} on ${url} for incident:${incidentId}.`,
    `Deploy ready means CI on this pull request succeeded, or the first snapshot arrived for env preview-${prNumber}.`,
    `Call query_metrics for ${validationMetrics.join(" and ")} on env preview-${prNumber}.`,
    "If both are recovered (within 10% of baseline), call close_incident.",
    "If deploy is not ready, or either metric is still off baseline, leave the reminder armed.",
    "Do not launch a cloud agent from this session.",
  ].join("\n");
}
