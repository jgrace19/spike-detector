import type { AuthContext, HostKvApi } from "@cursor/bdk";
import { incidentContinuation } from "./demo.js";
import { isRecord, toJson } from "./json.js";

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
  linearIssueId?: string;
  linearIssueUrl?: string;
  slackChannelId?: string;
  slackThreadTs?: string;
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
