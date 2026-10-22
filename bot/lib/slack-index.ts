import type { HostKvApi } from "@cursor/bdk";
import { isRecord, toJson } from "./json.js";

export type SlackMessageRole = "alert" | "triage";

export type SlackMessageRef = {
  incidentId: string;
  role: SlackMessageRole;
};

function slackTsKey(ts: string): string {
  return `slack-ts:${ts}`;
}

export async function rememberSlackMessage(
  kv: HostKvApi,
  ts: string,
  ref: SlackMessageRef,
): Promise<void> {
  await kv.put(slackTsKey(ts), toJson(ref));
}

export async function lookupSlackMessage(
  kv: HostKvApi,
  ts: string,
): Promise<SlackMessageRef | undefined> {
  const value = await kv.get(slackTsKey(ts));
  if (!isRecord(value) || typeof value.incidentId !== "string") {
    return undefined;
  }
  if (value.role !== "alert" && value.role !== "triage") {
    return undefined;
  }
  return { incidentId: value.incidentId, role: value.role };
}
