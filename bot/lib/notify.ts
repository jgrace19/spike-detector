import type { HostContext } from "@cursor/bdk";
import { codeOwnerSlackId, slackChannelTarget } from "./demo.js";
import type { IncidentRecord } from "./incidents.js";
import { commentLinearIssue } from "./linear.js";

export async function postSlack(input: {
  host: HostContext;
  incident: IncidentRecord;
  text: string;
  thread?: boolean;
}): Promise<{ posted: true; channel: string; ts: string } | { posted: false; reason: string }> {
  const channel = input.thread
    ? (input.incident.slackChannelId ?? slackChannelTarget())
    : slackChannelTarget();
  if (channel === "") {
    return { posted: false, reason: "slack_channel_unconfigured" };
  }
  try {
    const client = await input.host.slack.getClient();
    const result = await client.chat.postMessage({
      channel,
      text: input.text,
      ...(input.thread && input.incident.slackThreadTs
        ? { thread_ts: input.incident.slackThreadTs }
        : {}),
    });
    if (result.ok !== true || result.ts === undefined) {
      return { posted: false, reason: result.error ?? "slack_post_failed" };
    }
    return { posted: true, channel: result.channel ?? channel, ts: result.ts };
  } catch (error) {
    return {
      posted: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function pageText(incident: IncidentRecord, summary: string): string {
  const owner = codeOwnerSlackId();
  const mention = owner === "" ? "" : `<@${owner}> `;
  const lines = [
    `${mention}Marketplace anomaly incident:${incident.incidentId}`,
    `metric ${incident.metric} in ${incident.env}: value ${incident.value} vs baseline ${incident.baseline} (window ${incident.window}).`,
  ];
  if (incident.cloudAgentUrl !== undefined) {
    lines.push(`Cloud agent: ${incident.cloudAgentUrl}`);
  }
  if (incident.linearIssueId !== undefined) {
    lines.push(`Linear: ${incident.linearIssueId}`);
  }
  if (summary.trim() !== "") {
    lines.push(`Note: ${summary.trim()}`);
  }
  lines.push(`Reply in this thread with: signed off incident:${incident.incidentId}`);
  return lines.join("\n");
}

export async function commentIncident(
  host: HostContext,
  incident: IncidentRecord,
  text: string,
): Promise<{ slack: string; linear: string }> {
  let slack = "skipped";
  if (incident.slackThreadTs !== undefined) {
    const posted = await postSlack({ host, incident, text, thread: true });
    slack = posted.posted ? "posted" : posted.reason;
  }
  let linear = "skipped";
  if (incident.linearIssueId !== undefined) {
    const commented = await commentLinearIssue(host.mcp, {
      identifier: incident.linearIssueId,
      body: text,
    });
    linear = commented.ok ? "posted" : commented.message;
  }
  return { slack, linear };
}
