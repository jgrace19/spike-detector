import type { HostContext } from "@cursor/bdk";
import { getIncident } from "./incidents.js";
import { lookupSlackMessage } from "./slack-index.js";
import { ackSignoff, applySignoff, queueSignoffWake } from "./signoff.js";
import { incidentIdInText, isApprovalReply, slackTsMs } from "./public-text.js";

const SIGNOFF_REACTIONS = new Set(["+1", "thumbsup", "white_check_mark", "heavy_check_mark"]);

export const APPROVE_ACTION_ID = "approve_incident_fix";

type SlackLike = {
  text: string;
  body: string;
  markdown: string;
  ts: string;
  threadTs: string;
  channelId: string;
  reaction?: { name: string };
};

/**
 * Reactions on the alert are ignored. A sign-off reaction on the triage
 * message records once and never starts a model turn.
 */
export async function handleSignoffReaction(host: HostContext, message: SlackLike): Promise<void> {
  const name = message.reaction?.name?.split("::")[0];
  if (name === undefined || !SIGNOFF_REACTIONS.has(name)) {
    return;
  }
  const reactedTs = message.threadTs;
  const incident = await incidentForMessage(host, reactedTs, message.channelId);
  if (incident === undefined || incident.triageSlackTs !== reactedTs) {
    return;
  }
  const result = await applySignoff({
    host,
    incidentId: incident.incidentId,
    note: `approved with :${name}: reaction`,
    wake: (incidentId) => queueSignoffWake(host, incidentId),
  });
  if (result.status === "recorded" || result.status === "already") {
    await ackSignoff({ host, channel: message.channelId, ts: reactedTs });
  }
}

/**
 * `handled` means the caller must not start a model turn. Approval replies
 * before the triage message, and approvals on the alert, are ignored.
 */
export async function handleSignoffReply(
  host: HostContext,
  message: SlackLike,
): Promise<"handled" | "ignore"> {
  const text = message.markdown.trim() !== "" ? message.markdown : message.text;
  if (!isApprovalReply(text)) {
    return "ignore";
  }
  const incident = await incidentForMessage(host, message.threadTs, message.channelId);
  if (
    incident === undefined ||
    incident.triageSlackTs === undefined ||
    slackTsMs(message.ts) <= slackTsMs(incident.triageSlackTs)
  ) {
    return "handled";
  }
  const result = await applySignoff({
    host,
    incidentId: incident.incidentId,
    note: text,
    wake: (incidentId) => queueSignoffWake(host, incidentId),
  });
  if (result.status === "recorded" || result.status === "already") {
    await ackSignoff({ host, channel: message.channelId, ts: message.ts });
  }
  return "handled";
}

export async function handleApproveButton(
  host: HostContext,
  action: { actionId: string; value: string; channelId: string; messageTs: string },
): Promise<void> {
  if (action.actionId !== APPROVE_ACTION_ID || action.value.trim() === "") {
    return;
  }
  const incident = await getIncident(host.kv, action.value);
  if (incident === undefined || incident.triageSlackTs !== action.messageTs) {
    return;
  }
  const result = await applySignoff({
    host,
    incidentId: incident.incidentId,
    note: "approved with the Approve fix button",
    wake: (incidentId) => queueSignoffWake(host, incidentId),
  });
  if (result.status === "recorded" || result.status === "already") {
    await ackSignoff({ host, channel: action.channelId, ts: action.messageTs });
  }
}

async function incidentForMessage(host: HostContext, ts: string, channelId: string) {
  const indexed = await lookupSlackMessage(host.kv, ts);
  if (indexed !== undefined) {
    return getIncident(host.kv, indexed.incidentId);
  }
  const fromSlack = await incidentIdFromSlack(host, channelId, ts);
  if (fromSlack === undefined) {
    return undefined;
  }
  return getIncident(host.kv, fromSlack);
}

async function incidentIdFromSlack(
  host: HostContext,
  channelId: string,
  ts: string,
): Promise<string | undefined> {
  try {
    const client = await host.slack.getClient();
    const replies = await client.conversations.replies({
      channel: channelId,
      ts,
      limit: 20,
      inclusive: true,
    });
    for (const message of replies.messages ?? []) {
      const id = incidentIdInText(message.text ?? "");
      if (id !== undefined) {
        return id;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
