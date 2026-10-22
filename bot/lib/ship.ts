import type { HostContext } from "@cursor/bdk";
import { notifyDeployHook } from "./deploy-hook.js";
import { demo, codeOwnerSlackId } from "./demo.js";
import { getIncident, updateIncident, type IncidentRecord } from "./incidents.js";
import { isRecord } from "./json.js";
import { postSlack } from "./notify.js";
import { serialize } from "./serialize.js";
import { incidentForSlackTs } from "./slack-signoff.js";
import {
  DEPLOY_HOOK_FAILED_TEXT,
  shipReviewPayload,
  shipReviewSummary,
  shippingPayload,
} from "./slack-cards.js";
import { getShipped, putShipped } from "./shipped.js";

export const SHIP_LABEL = "ship";

const SHIP_COMMENT = /^Approved for production by @.+ via Slack$/;

export type ShipOutcome =
  | { status: "shipped"; prNumber: number }
  | { status: "already"; prNumber: number }
  | { status: "ignored" }
  | { status: "failed"; reason: string };

type ReactionMessage = {
  threadTs: string;
  channelId: string;
  reaction?: { name: string };
  author?: { userId: string; userName?: string };
};

/**
 * A rocket on the ship-review message records the ship and posts the shipping
 * line. The GitHub label and comment are best effort and do not gate the
 * record. It does not merge. Rockets on the alert, the triage card, or the
 * pull request link do nothing. A second rocket does not comment or post again.
 */
export async function handleShipReaction(
  host: HostContext,
  message: ReactionMessage,
): Promise<ShipOutcome> {
  const name = message.reaction?.name?.split("::")[0];
  if (name !== "rocket") {
    return { status: "ignored" };
  }
  const incident = await incidentForSlackTs(host, message.threadTs, message.channelId);
  if (incident === undefined || incident.shipReviewSlackTs !== message.threadTs) {
    return { status: "ignored" };
  }
  const approver = await approverLabel(host, message.author);
  return approveForProduction({ host, incidentId: incident.incidentId, approver });
}

export async function approveForProduction(input: {
  host: HostContext;
  incidentId: string;
  approver: string;
}): Promise<ShipOutcome> {
  return serialize(`ship:${input.incidentId}`, () => approveLocked(input));
}

async function approveLocked(input: {
  host: HostContext;
  incidentId: string;
  approver: string;
}): Promise<ShipOutcome> {
  const incident = await getIncident(input.host.kv, input.incidentId);
  if (incident === undefined) {
    return { status: "failed", reason: "unknown_incident" };
  }
  if (incident.prNumber === undefined) {
    return { status: "failed", reason: "no_pull_request" };
  }
  if (incident.slackThreadTs === undefined) {
    return { status: "failed", reason: "no_slack_thread" };
  }
  const threadTs = incident.slackThreadTs;
  const prNumber = incident.prNumber;
  const existing = await getShipped(input.host.kv, incident.incidentId);
  if (
    incident.shippedAt !== undefined &&
    existing !== undefined &&
    incident.shippingPostedAt !== undefined
  ) {
    return { status: "already", prNumber };
  }

  let octokit: HostOctokit | undefined;
  try {
    octokit = await input.host.github.getOctokit();
  } catch (error) {
    console.warn(`[spike-detector] github client unavailable: ${errorText(error)}`);
  }

  let branch = existing?.branch ?? incident.headBranch;
  let headSha = existing?.headSha ?? incident.headSha;
  if (octokit !== undefined) {
    try {
      const head = await readPullHead(octokit, prNumber);
      if (head.branch !== undefined) {
        branch = head.branch;
      }
      if (head.headSha !== undefined) {
        headSha = head.headSha;
      }
    } catch (error) {
      console.warn(`[spike-detector] pull request head read failed: ${errorText(error)}`);
    }
  }

  const shippedAt = incident.shippedAt ?? existing?.shippedAt ?? new Date().toISOString();
  await putShipped(input.host.kv, {
    incidentId: incident.incidentId,
    prNumber,
    threadTs,
    shippedAt,
    ...(incident.prUrl === undefined ? {} : { prUrl: incident.prUrl }),
    ...(incident.slackChannelId === undefined ? {} : { channelId: incident.slackChannelId }),
    ...(incident.linearIssueId === undefined ? {} : { linearIssueId: incident.linearIssueId }),
    ...(incident.linearIssueUrl === undefined ? {} : { linearIssueUrl: incident.linearIssueUrl }),
    ...(incident.shipReviewSlackTs === undefined ? {} : { reviewTs: incident.shipReviewSlackTs }),
    ...(branch === undefined || branch === "" ? {} : { branch }),
    ...(headSha === undefined || headSha === "" ? {} : { headSha }),
    approver: input.approver,
  });
  const recorded = await updateIncident(input.host.kv, incident.incidentId, {
    ...(incident.shippedAt === undefined ? { shippedAt } : {}),
    ...(branch === undefined || branch === "" ? {} : { headBranch: branch }),
    ...(headSha === undefined || headSha === "" ? {} : { headSha }),
  });
  let current = recorded ?? incident;

  let shippingFailure: string | undefined;
  if (current.shippingPostedAt === undefined) {
    const payload = shippingPayload();
    const posted = await postSlack({
      host: input.host,
      incident: current,
      text: payload.text,
      blocks: payload.blocks,
      thread: true,
    });
    if (!posted.posted) {
      shippingFailure = posted.reason;
    } else {
      const updated = await updateIncident(input.host.kv, current.incidentId, {
        shippingPostedAt: new Date().toISOString(),
      });
      if (updated !== undefined) {
        current = updated;
      }
    }
  }

  const hook = await notifyDeployHook({
    incidentId: current.incidentId,
    prNumber,
    branch: branch ?? "",
    headSha: headSha ?? "",
  });
  if (hook.status === "failed") {
    console.warn(`[spike-detector] deploy hook failed: ${hook.reason}`);
    const noted = await postSlack({
      host: input.host,
      incident: current,
      text: DEPLOY_HOOK_FAILED_TEXT,
      thread: true,
    });
    if (!noted.posted) {
      console.warn(`[spike-detector] deploy hook note failed: ${noted.reason}`);
    }
  }

  if (octokit !== undefined) {
    try {
      await ensureShipLabel(octokit, prNumber);
    } catch (error) {
      console.warn(`[spike-detector] ship label failed: ${errorText(error)}`);
    }
    try {
      await commentOnce(octokit, prNumber, shipApprovalComment(input.approver));
    } catch (error) {
      console.warn(`[spike-detector] ship comment failed: ${errorText(error)}`);
    }
  }
  if (shippingFailure !== undefined) {
    return { status: "failed", reason: shippingFailure };
  }
  return { status: "shipped", prNumber };
}

/** Post the review card once, in the incident thread, after the pull request link. */
export async function postShipReview(
  host: HostContext,
  incident: IncidentRecord,
  prUrl: string,
  prNumber: number | undefined,
): Promise<{ posted: boolean; already?: boolean; ts?: string; reason?: string }> {
  if (incident.shipReviewSlackTs !== undefined) {
    return { posted: true, already: true, ts: incident.shipReviewSlackTs };
  }
  if (incident.slackThreadTs === undefined) {
    return { posted: false, reason: "no_slack_thread" };
  }
  const payload = shipReviewPayload({
    incidentId: incident.incidentId,
    ownerId: codeOwnerSlackId(),
    prUrl,
    prNumber,
    summary: shipReviewSummary(incident.triageReport),
  });
  const posted = await postSlack({
    host,
    incident,
    text: payload.text,
    blocks: payload.blocks,
    thread: true,
    role: "ship_review",
  });
  if (!posted.posted) {
    return posted;
  }
  await updateIncident(host.kv, incident.incidentId, {
    shipReviewSlackTs: posted.ts,
    prUrl,
    ...(prNumber === undefined ? {} : { prNumber }),
  });
  return { posted: true, ts: posted.ts };
}

type HostOctokit = Awaited<ReturnType<HostContext["github"]["getOctokit"]>>;

async function readPullHead(
  octokit: HostOctokit,
  prNumber: number,
): Promise<{ branch?: string; headSha?: string }> {
  const response = await octokit.rest.pulls.get({
    owner: demo.owner,
    repo: demo.repo,
    pull_number: prNumber,
  });
  const ref = response.data.head.ref;
  const sha = response.data.head.sha;
  return {
    ...(ref === "" ? {} : { branch: ref }),
    ...(sha === "" ? {} : { headSha: sha }),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function shipApprovalComment(approver: string): string {
  const name = approver.replace(/\s+/g, " ").trim().slice(0, 80);
  return `Approved for production by @${name === "" ? "unknown" : name} via Slack`;
}

async function ensureShipLabel(octokit: HostOctokit, prNumber: number): Promise<void> {
  try {
    await octokit.rest.issues.createLabel({
      owner: demo.owner,
      repo: demo.repo,
      name: SHIP_LABEL,
      color: "1D9E75",
      description: "Approved for production",
    });
  } catch (error) {
    if (!isLabelAlreadyExists(error)) {
      throw error;
    }
  }
  await octokit.rest.issues.addLabels({
    owner: demo.owner,
    repo: demo.repo,
    issue_number: prNumber,
    labels: [SHIP_LABEL],
  });
}

async function commentOnce(octokit: HostOctokit, prNumber: number, body: string): Promise<void> {
  const listed = await octokit.rest.issues.listComments({
    owner: demo.owner,
    repo: demo.repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const exists = listed.data.some((comment) => SHIP_COMMENT.test((comment.body ?? "").trim()));
  if (exists) {
    return;
  }
  await octokit.rest.issues.createComment({
    owner: demo.owner,
    repo: demo.repo,
    issue_number: prNumber,
    body,
  });
}

async function approverLabel(
  host: HostContext,
  author: ReactionMessage["author"],
): Promise<string> {
  if (author?.userName !== undefined && author.userName.trim() !== "") {
    return author.userName.trim();
  }
  const userId = author?.userId;
  if (userId === undefined || userId === "") {
    return "unknown";
  }
  try {
    const client = await host.slack.getClient();
    const info = await client.users.info({ user: userId });
    const profile = info.user?.profile;
    const name =
      profile?.display_name_normalized ||
      profile?.display_name ||
      info.user?.name ||
      info.user?.real_name;
    if (name !== undefined && name.trim() !== "") {
      return name.trim();
    }
  } catch {
    // users:read may be missing. The Slack user id still identifies them.
  }
  return userId;
}

function isLabelAlreadyExists(error: unknown): boolean {
  if (!isRecord(error) || error.status !== 422) {
    return false;
  }
  const response = error.response;
  if (isRecord(response) && isRecord(response.data) && Array.isArray(response.data.errors)) {
    return response.data.errors.some((entry) => isRecord(entry) && entry.code === "already_exists");
  }
  const message = typeof error.message === "string" ? error.message : "";
  return /already exists/i.test(message);
}
