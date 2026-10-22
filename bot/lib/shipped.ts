import type { HostKvApi } from "@cursor/bdk";
import { readIds, rememberId } from "./id-index.js";
import { getIncident } from "./incidents.js";
import { isRecord, toJson } from "./json.js";

const SHIPPED_INDEX_KEY = "shipped-ids";

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
  /** Head branch at ship time. A GitHub read wins; otherwise the stored branch. */
  branch?: string;
  /** Head SHA at ship time. A GitHub read wins; otherwise the stored SHA. */
  headSha?: string;
};

/** One unresolved ship, in the shape the poll route returns. */
export type ShippedItem = {
  incidentId: string;
  prNumber: number;
  branch: string;
  headSha: string;
  shippedAt: string;
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
    ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
    ...(typeof value.headSha === "string" ? { headSha: value.headSha } : {}),
  };
}

export async function putShipped(kv: HostKvApi, record: ShippedRecord): Promise<void> {
  await kv.put(shippedKey(record.incidentId), toJson(record));
  await rememberId(kv, SHIPPED_INDEX_KEY, record.incidentId);
}

export async function listShippedIds(kv: HostKvApi): Promise<string[]> {
  return readIds(kv, SHIPPED_INDEX_KEY);
}

export function shippedIndexKey(): string {
  return SHIPPED_INDEX_KEY;
}

/** Shipped incidents that are not resolved. A missing incident has not resolved. */
export async function listUnresolvedShipped(kv: HostKvApi): Promise<ShippedItem[]> {
  const ids = await listShippedIds(kv);
  const items: ShippedItem[] = [];
  for (const incidentId of ids) {
    const shipped = await getShipped(kv, incidentId);
    if (shipped === undefined) {
      continue;
    }
    const incident = await getIncident(kv, incidentId);
    if (incident?.status === "closed") {
      continue;
    }
    items.push({
      incidentId: shipped.incidentId,
      prNumber: shipped.prNumber,
      branch: shipped.branch ?? "",
      headSha: shipped.headSha ?? "",
      shippedAt: shipped.shippedAt,
    });
  }
  return items;
}
