import type { HostContext } from "@cursor/bdk";
import { getCloudAgent } from "@cursor/bdk/extensions/cursor-cloud-agents";
import { postOrUpdateAlert } from "./alert-post.js";
import { getIncident, updateIncident, type IncidentRecord } from "./incidents.js";
import { postSlack } from "./notify.js";
import { prNumberFromUrl, scrubPublicText, stringField } from "./public-text.js";
import { serialize } from "./serialize.js";
import { pullRequestPayload, triageErrorPayload, triagePayload } from "./slack-cards.js";
import { codeOwnerSlackId } from "./demo.js";
import { postShipReview } from "./ship.js";
import { parseTriageReport, reportAsPlan, reportHasFindings } from "./triage-report.js";
import { armPreviewWatch } from "./watch.js";

type AgentHint = {
  status?: string;
  prUrl?: string;
  summary?: string;
  error?: string;
};

export type CloudStopPost = {
  posted: boolean;
  reason?: string;
  already?: boolean;
  kind?: string;
  ts?: string;
  channel?: string;
  url?: string;
  prNumber?: number;
  watch?: string;
  status?: string;
};

type TranscriptMessage = {
  role: string;
  text?: string;
};

/**
 * Post the triage card or the fix pull request when a watched cloud agent
 * stops. Idempotent across the stop hook and a later model tool call.
 */
export async function publishCloudStop(input: {
  host: HostContext;
  incidentId: string;
  hint?: AgentHint;
}): Promise<CloudStopPost> {
  return serialize(`cloud-stop:${input.incidentId}`, () => publishLocked(input));
}

async function publishLocked(input: {
  host: HostContext;
  incidentId: string;
  hint?: AgentHint;
}): Promise<CloudStopPost> {
  const incident = await getIncident(input.host.kv, input.incidentId);
  if (incident === undefined) {
    return { posted: false, reason: "unknown_incident" };
  }
  if (incident.cloudAgentId === undefined) {
    return { posted: false, reason: "no_cloud_agent" };
  }
  const live = await readAgent(incident.cloudAgentId, input.hint);
  const status = isStopped(live.status) ? live.status : (input.hint?.status ?? live.status);
  if (incident.fixRequestedAt !== undefined) {
    return announceFix(input.host, incident, live.prUrl ?? input.hint?.prUrl);
  }
  if (!isStopped(status)) {
    return { posted: false, reason: "agent_running", status };
  }
  if (status === "error" || status === "expired") {
    return postTriageFailure(input.host, incident, live.error ?? live.summary ?? status);
  }
  return postTriageResult(input.host, incident, live.summary ?? input.hint?.summary);
}

async function postTriageResult(
  host: HostContext,
  incident: IncidentRecord,
  summary: string | undefined,
): Promise<CloudStopPost> {
  const current = await ensureThread(host, incident);
  if (current.triageSlackTs !== undefined) {
    return { posted: true, already: true, ts: current.triageSlackTs, kind: "triage" };
  }
  if (current.slackThreadTs === undefined || current.slackChannelId === undefined) {
    return { posted: false, reason: "no_slack_thread" };
  }
  const text = await agentReportText(current.cloudAgentId ?? "", summary);
  const report = parseTriageReport(text);
  if (!reportHasFindings(report)) {
    return postTriageFailure(host, current, "Triage finished without a written report.");
  }
  const payload = triagePayload({
    incident: current,
    report,
    ownerId: codeOwnerSlackId(),
  });
  const posted = await postSlack({
    host,
    incident: current,
    text: payload.text,
    blocks: payload.blocks,
    thread: true,
    role: "triage",
  });
  if (!posted.posted) {
    return posted;
  }
  await updateIncident(host.kv, current.incidentId, {
    triageSlackTs: posted.ts,
    triageReport: reportAsPlan(report),
  });
  return { posted: true, kind: "triage", channel: posted.channel, ts: posted.ts };
}

async function postTriageFailure(
  host: HostContext,
  incident: IncidentRecord,
  detail: string,
): Promise<CloudStopPost> {
  if (incident.triageErrorPostedAt !== undefined || incident.triageSlackTs !== undefined) {
    return { posted: true, already: true, kind: "triage_error" };
  }
  const current = await ensureThread(host, incident);
  if (current.slackThreadTs === undefined) {
    return { posted: false, reason: "no_slack_thread" };
  }
  const payload = triageErrorPayload(current, scrubPublicText(detail));
  const posted = await postSlack({
    host,
    incident: current,
    text: payload.text,
    blocks: payload.blocks,
    thread: true,
  });
  if (!posted.posted) {
    return posted;
  }
  await updateIncident(host.kv, current.incidentId, {
    triageErrorPostedAt: new Date().toISOString(),
  });
  return { posted: true, kind: "triage_error", ts: posted.ts };
}

async function announceFix(
  host: HostContext,
  incident: IncidentRecord,
  prUrl: string | undefined,
): Promise<CloudStopPost> {
  if (prUrl === undefined) {
    return { posted: false, reason: "no_pull_request" };
  }
  const current = await ensureThread(host, incident);
  if (current.slackThreadTs === undefined) {
    return { posted: false, reason: "no_slack_thread" };
  }
  const prNumber = prNumberFromUrl(prUrl) ?? current.prNumber;
  const alreadyAnnounced = current.prNotifiedAt !== undefined;
  const alreadyReviewed = current.shipReviewSlackTs !== undefined;
  if (alreadyAnnounced && alreadyReviewed) {
    return { posted: true, already: true, kind: "pull_request", url: current.prUrl ?? prUrl };
  }
  let watch: string | undefined;
  let ts: string | undefined;
  if (!alreadyAnnounced) {
    const payload = pullRequestPayload(prUrl, prNumber);
    const posted = await postSlack({
      host,
      incident: current,
      text: payload.text,
      blocks: payload.blocks,
      thread: true,
    });
    if (!posted.posted) {
      return posted;
    }
    ts = posted.ts;
    await updateIncident(host.kv, current.incidentId, {
      prUrl,
      prNotifiedAt: new Date().toISOString(),
      ...(prNumber === undefined ? {} : { prNumber }),
    });
    if (prNumber !== undefined) {
      const armed = await armPreviewWatch(host, {
        incidentId: current.incidentId,
        prNumber,
        metric: current.metric,
      });
      watch = armed.armed ? armed.reminderId : armed.reason;
    }
  }
  const refreshed = (await getIncident(host.kv, current.incidentId)) ?? current;
  if (refreshed.shipReviewSlackTs === undefined) {
    const review = await postShipReview(host, { ...refreshed, prUrl }, prUrl, prNumber);
    if (review.posted) {
      ts = review.ts ?? ts;
    } else {
      console.warn(`[spike-detector] ship review post failed: ${review.reason ?? "unknown"}`);
    }
  }
  return {
    posted: true,
    kind: "pull_request",
    url: prUrl,
    prNumber,
    watch,
    ts,
    ...(alreadyAnnounced && alreadyReviewed ? { already: true } : {}),
  };
}

async function ensureThread(host: HostContext, incident: IncidentRecord): Promise<IncidentRecord> {
  if (incident.slackThreadTs !== undefined) {
    return incident;
  }
  await postOrUpdateAlert(host, incident);
  return (await getIncident(host.kv, incident.incidentId)) ?? incident;
}

async function readAgent(agentId: string, hint: AgentHint | undefined): Promise<AgentHint & { status: string }> {
  try {
    const info = await getCloudAgent(agentId);
    return {
      status: info.status,
      prUrl: info.prUrl ?? hint?.prUrl,
      summary: info.summary ?? hint?.summary,
      error: info.error ?? hint?.error,
    };
  } catch {
    return {
      status: hint?.status ?? "unknown",
      prUrl: hint?.prUrl,
      summary: hint?.summary,
      error: hint?.error,
    };
  }
}

function isStopped(status: string | undefined): boolean {
  return status === "finished" || status === "error" || status === "expired";
}

async function agentReportText(agentId: string, summary: string | undefined): Promise<string> {
  if (agentId === "") {
    return summary ?? "";
  }
  try {
    const messages = await loadConversation(agentId);
    const finalText = lastAssistantText(messages);
    if (finalText !== undefined && finalText.trim() !== "") {
      return summary !== undefined && summary.trim() !== "" ? `${finalText}\n${summary}` : finalText;
    }
  } catch (error) {
    console.warn(
      `[spike-detector] could not read cloud agent transcript: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return summary ?? "";
}

function lastAssistantText(messages: readonly TranscriptMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.text !== undefined && message.text.trim() !== "") {
      return message.text;
    }
  }
  return undefined;
}

async function loadConversation(agentId: string): Promise<TranscriptMessage[]> {
  // Package exports hide this file. Load it by path so the stop hook can
  // read the final report without a model turn. Failure falls back to the
  // agent summary.
  const href = new URL(
    "../../node_modules/@cursor/bdk/dist/extensions/cursor-cloud-agents/lib/backend.js",
    import.meta.url,
  ).href;
  const mod = (await import(href)) as {
    cloudAgentsBackend?: () => {
      conversation: (id: string) => Promise<TranscriptMessage[]>;
    };
  };
  if (mod.cloudAgentsBackend === undefined) {
    return [];
  }
  return mod.cloudAgentsBackend().conversation(agentId);
}

/** Post the pull request link once. Shares the stop lock so the hook cannot double-post. */
export async function announceKnownPullRequest(
  host: HostContext,
  incidentId: string,
  prUrl: string,
): Promise<CloudStopPost> {
  return serialize(`cloud-stop:${incidentId}`, async () => {
    const incident = await getIncident(host.kv, incidentId);
    if (incident === undefined) {
      return { posted: false, reason: "unknown_incident" };
    }
    return announceFix(host, incident, prUrl);
  });
}

export function hintFromInfo(info: Record<string, unknown>): AgentHint {
  return {
    status: stringField(info, "status"),
    prUrl: stringField(info, "prUrl"),
    summary: stringField(info, "summary"),
    error: stringField(info, "error"),
  };
}
