import type { AuthContext, HostKvApi } from "@cursor/bdk";
import { incidentContinuation } from "./demo.js";
import { readIds, rememberId } from "./id-index.js";
import { isRecord, toJson } from "./json.js";

const INCIDENT_INDEX_KEY = "incident-ids";

export type IncidentStatus = "received" | "expected" | "bug" | "closed";

export type StoredPrincipal = {
  authenticator: string;
  principalId: string;
  principalType: "user" | "service" | "runtime";
};

export type IncidentRecord = {
  incidentId: string;
  metric: string;
  env: string;
  baseline: number;
  value: number;
  window: string;
  status: IncidentStatus;
  sessionStarted: boolean;
  updatedAt: string;
  note?: string;
  principal?: StoredPrincipal;
  cloudAgentId?: string;
  cloudAgentUrl?: string;
  /** Branch the cloud agent started from. Fix PRs target this ref. */
  startingRef?: string;
  /** Head branch of the fix pull request, when a read or an earlier ship stored it. */
  headBranch?: string;
  /** Head commit of the fix pull request, when a read or an earlier ship stored it. */
  headSha?: string;
  linearIssueId?: string;
  linearIssueUrl?: string;
  slackChannelId?: string;
  /** Thread root: the alert message. */
  slackThreadTs?: string;
  /** Triage result in that thread. Only this message accepts sign-off. */
  triageSlackTs?: string;
  /** Scrubbed triage report. `request_fix` uses it as the plan. */
  triageReport?: string;
  /** Set when a triage run stopped without a report worth approving. */
  triageErrorPostedAt?: string;
  fixProgressPostedAt?: string;
  prNotifiedAt?: string;
  signedOffAt?: string;
  signedOffNote?: string;
  signoffWakeSent?: boolean;
  signoffReminderId?: string;
  fixRequestedAt?: string;
  prNumber?: number;
  prUrl?: string;
  previewReminderId?: string;
  /** Set when a GitHub check suite or check run for the fix PR succeeds. */
  ciSucceededAt?: string;
  /** Review card that accepts a rocket reaction. Only this message ships. */
  shipReviewSlackTs?: string;
  /** Set after the rocket reaction labels the pull request. */
  shippedAt?: string;
  /** Set after "Shipping to production…" is posted. */
  shippingPostedAt?: string;
  /** Set after the production resolution is posted. */
  resolutionPostedAt?: string;
};

export function incidentKey(incidentId: string): string {
  return incidentContinuation(incidentId);
}

export function principalFromAuth(auth: AuthContext | null): StoredPrincipal | undefined {
  if (auth === null) {
    return undefined;
  }
  return {
    authenticator: auth.authenticator,
    principalId: auth.principalId,
    principalType: auth.principalType,
  };
}

export async function getIncident(
  kv: HostKvApi,
  incidentId: string,
): Promise<IncidentRecord | undefined> {
  const value = await kv.get(incidentKey(incidentId));
  if (!isRecord(value) || value.incidentId !== incidentId) {
    return undefined;
  }
  return value as IncidentRecord;
}

export async function putIncident(kv: HostKvApi, record: IncidentRecord): Promise<void> {
  await kv.put(incidentKey(record.incidentId), toJson(record));
  await rememberId(kv, INCIDENT_INDEX_KEY, record.incidentId);
}

export async function listIncidentIds(kv: HostKvApi): Promise<string[]> {
  return readIds(kv, INCIDENT_INDEX_KEY);
}

export async function deleteIncident(kv: HostKvApi, incidentId: string): Promise<void> {
  await kv.delete(incidentKey(incidentId));
}

export function incidentIndexKey(): string {
  return INCIDENT_INDEX_KEY;
}

export async function updateIncident(
  kv: HostKvApi,
  incidentId: string,
  patch: Partial<IncidentRecord>,
): Promise<IncidentRecord | undefined> {
  const current = await getIncident(kv, incidentId);
  if (current === undefined) {
    return undefined;
  }
  const next: IncidentRecord = {
    ...current,
    ...patch,
    incidentId: current.incidentId,
    updatedAt: new Date().toISOString(),
  };
  await putIncident(kv, next);
  return next;
}
