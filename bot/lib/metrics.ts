import type { HostKvApi } from "@cursor/bdk";
import { demo } from "./demo.js";
import { isRecord, toJson } from "./json.js";

export type MetricSnapshot = {
  metric: string;
  env: string;
  value: number;
  baseline?: number;
  window?: string;
  at: string;
  incidentId?: string;
};

const MAX_SNAPSHOTS = 48;

export function metricKey(env: string, metric: string): string {
  return `metrics:${env}:${metric}`;
}

export function isRecovered(value: number, baseline: number): boolean {
  const scale = Math.max(Math.abs(baseline), 1);
  return Math.abs(value - baseline) / scale <= demo.recoveryTolerance;
}

export async function appendSnapshot(kv: HostKvApi, snapshot: MetricSnapshot): Promise<void> {
  const key = metricKey(snapshot.env, snapshot.metric);
  const current = await kv.get(key);
  const snapshots = Array.isArray(current) ? current.filter(isSnapshot) : [];
  const last = snapshots[snapshots.length - 1];
  if (
    last !== undefined &&
    last.at === snapshot.at &&
    last.value === snapshot.value &&
    last.env === snapshot.env &&
    last.metric === snapshot.metric
  ) {
    return;
  }
  snapshots.push(snapshot);
  const capped = snapshots.slice(-MAX_SNAPSHOTS);
  await kv.put(key, toJson(capped));
}

export async function latestSnapshot(
  kv: HostKvApi,
  env: string,
  metric: string,
): Promise<MetricSnapshot | undefined> {
  const current = await kv.get(metricKey(env, metric));
  if (!Array.isArray(current)) {
    return undefined;
  }
  const snapshots = current.filter(isSnapshot);
  return snapshots[snapshots.length - 1];
}

function isSnapshot(value: unknown): value is MetricSnapshot {
  return (
    isRecord(value) &&
    typeof value.metric === "string" &&
    typeof value.env === "string" &&
    typeof value.value === "number" &&
    typeof value.at === "string"
  );
}
