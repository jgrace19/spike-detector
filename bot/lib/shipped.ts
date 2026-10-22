import type { HostKvApi } from "@cursor/bdk";
import { isRecord, toJson } from "./json.js";

/**
 * Written when a rocket reaction ships a fix. Recovery looks this up by
 * incident id. The incident record alone is not the lookup key.
 */
export type ShippedRecord = {
  incidentId: string;
  prNumber: number;
  prUrl?: string;
  /** Slack thread root. Resolution posts here. */
  threadTs: string;
  channelId?: string;
  linearIssueId?: string;
  linearIssueUrl?: string;
  /** Message ts that accepted the rocket reaction. */
  reviewTs?: string;
  shippedAt: string;
  approver?: string;
};

export function shippedKey(incidentId: string): string {
  return `shipped:${incidentId}`;
}

export async function getShipped(
  kv: HostKvApi,
  incidentId: string,
): Promise<ShippedRecord | undefined> {
  const value = await kv.get(shippedKey(incidentId));
  if (!isRecord(value) || value.incidentId !== incidentId) {
    return undefined;
  }
  if (typeof value.prNumber !== "number" || typeof value.threadTs !== "string") {
    return undefined;
  }
  return {
    incidentId,
    prNumber: value.prNumber,
    threadTs: value.threadTs,
    shippedAt: typeof value.shippedAt === "string" ? value.shippedAt : "",
    ...(typeof value.prUrl === "string" ? { prUrl: value.prUrl } : {}),
    ...(typeof value.channelId === "string" ? { channelId: value.channelId } : {}),
    ...(typeof value.linearIssueId === "string" ? { linearIssueId: value.linearIssueId } : {}),
    ...(typeof value.linearIssueUrl === "string" ? { linearIssueUrl: value.linearIssueUrl } : {}),
    ...(typeof value.reviewTs === "string" ? { reviewTs: value.reviewTs } : {}),
    ...(typeof value.approver === "string" ? { approver: value.approver } : {}),
  };
}

export async function putShipped(kv: HostKvApi, record: ShippedRecord): Promise<void> {
  await kv.put(shippedKey(record.incidentId), toJson(record));
}
