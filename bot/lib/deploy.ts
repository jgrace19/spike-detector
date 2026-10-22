import type { HostKvApi } from "@cursor/bdk";
import { previewEnv } from "./demo.js";
import { getIncident, updateIncident, type IncidentRecord } from "./incidents.js";
import { toJson } from "./json.js";

export function prIndexKey(prNumber: number): string {
  return `pr:${prNumber}`;
}

export function previewSignalKey(env: string): string {
  return `preview-signal:${env}`;
}

export async function linkPullRequest(
  kv: HostKvApi,
  incidentId: string,
  prNumber: number,
): Promise<void> {
  await kv.put(prIndexKey(prNumber), incidentId);
}

export async function incidentIdForPullRequest(
  kv: HostKvApi,
  prNumber: number,
): Promise<string | undefined> {
  const value = await kv.get(prIndexKey(prNumber));
  return typeof value === "string" ? value : undefined;
}

/** Record the first snapshot posted for a `preview-<pr>` env. Later posts no-op. */
export async function notePreviewSignal(
  kv: HostKvApi,
  env: string,
  metric: string,
): Promise<boolean> {
  const key = previewSignalKey(env);
  if ((await kv.get(key)) !== undefined) {
    return false;
  }
  await kv.put(key, toJson({ env, metric, at: new Date().toISOString() }));
  return true;
}

export async function markCiSuccess(kv: HostKvApi, prNumbers: readonly number[]): Promise<void> {
  for (const prNumber of prNumbers) {
    const incidentId = await incidentIdForPullRequest(kv, prNumber);
    if (incidentId === undefined) {
      continue;
    }
    const incident = await getIncident(kv, incidentId);
    if (incident === undefined || incident.ciSucceededAt !== undefined) {
      continue;
    }
    await updateIncident(kv, incidentId, {
      ciSucceededAt: new Date().toISOString(),
      prNumber,
    });
  }
}

/**
 * A preview is ready when the pull request's CI checks succeeded, or when
 * the first metric snapshot for `preview-<pr>` has been stored. There is
 * no deployment-host callback.
 */
export async function isDeployReady(
  kv: HostKvApi,
  incident: Pick<IncidentRecord, "ciSucceededAt">,
  prNumber: number,
): Promise<{ ready: true; reason: "ci_success" | "preview_metrics" } | { ready: false }> {
  if (incident.ciSucceededAt !== undefined) {
    return { ready: true, reason: "ci_success" };
  }
  const signal = await kv.get(previewSignalKey(previewEnv(prNumber)));
  if (signal !== undefined) {
    return { ready: true, reason: "preview_metrics" };
  }
  return { ready: false };
}
