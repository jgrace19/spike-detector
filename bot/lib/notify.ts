import type { HostContext } from "@cursor/bdk";
import type { IncidentRecord } from "./incidents.js";
import { slackChannelTarget } from "./demo.js";
import { commentLinearIssue } from "./linear.js";
import type { SlackBlock } from "./slack-cards.js";
import { rememberSlackMessage, type SlackMessageRole } from "./slack-index.js";

export async function postSlack(input: {
  host: HostContext;
  incident: IncidentRecord;
  text: string;
  blocks?: SlackBlock[];
  thread?: boolean;
  role?: SlackMessageRole;
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
      unfurl_links: false,
      unfurl_media: false,
      ...(input.blocks === undefined ? {} : { blocks: input.blocks as never }),
      ...(input.thread && input.incident.slackThreadTs
        ? { thread_ts: input.incident.slackThreadTs }
        : {}),
    });
    if (result.ok !== true || result.ts === undefined) {
      return { posted: false, reason: result.error ?? "slack_post_failed" };
    }
    const postedChannel = result.channel ?? channel;
    if (input.role !== undefined) {
      try {
        await rememberSlackMessage(input.host.kv, result.ts, {
          incidentId: input.incident.incidentId,
          role: input.role,
        });
      } catch (error) {
        console.warn(
          `[spike-detector] slack index write failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { posted: true, channel: postedChannel, ts: result.ts };
  } catch (error) {
    return {
      posted: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function updateSlack(input: {
  host: HostContext;
  channel: string;
  ts: string;
  text: string;
  blocks?: SlackBlock[];
}): Promise<{ updated: true } | { updated: false; reason: string }> {
  try {
    const client = await input.host.slack.getClient();
    const result = await client.chat.update({
      channel: input.channel,
      ts: input.ts,
      text: input.text,
      ...(input.blocks === undefined ? {} : { blocks: input.blocks as never }),
    });
    if (result.ok !== true) {
      return { updated: false, reason: result.error ?? "slack_update_failed" };
    }
    return { updated: true };
  } catch (error) {
    return {
      updated: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function addReaction(input: {
  host: HostContext;
  channel: string;
  ts: string;
  name: string;
}): Promise<void> {
  try {
    const client = await input.host.slack.getClient();
    await client.reactions.add({
      channel: input.channel,
      timestamp: input.ts,
      name: input.name,
    });
  } catch {
    // already_reacted, or reactions are unavailable in this workspace.
  }
}

export async function commentIncident(
  host: HostContext,
  incident: IncidentRecord,
  text: string,
  blocks?: SlackBlock[],
): Promise<{ slack: string; linear: string }> {
  let slack = "skipped";
  if (incident.slackThreadTs !== undefined) {
    const posted = await postSlack({ host, incident, text, blocks, thread: true });
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
