import type { HostContext } from "@cursor/bdk";
import cloudStopWatch from "../reminders/cloud_stop_watch.js";
import { incidentContinuation } from "./demo.js";

const POLL = "20s";

/**
 * Poll the launched agent sooner than the extension's one-minute stop
 * wake, and post from the reminder itself. The wake still runs; posting
 * is idempotent. A fix watch ignores the triage run's finished status
 * until it has seen the follow-up running or a new pull request URL.
 */
export async function armCloudStopWatch(
  host: HostContext,
  input: {
    incidentId: string;
    agentId: string;
    phase: "triage" | "fix";
    baselinePrUrl?: string;
  },
): Promise<void> {
  if (host.reminders === undefined) {
    return;
  }
  const purpose = `cloud-stop:${input.phase}:${input.incidentId}:${input.agentId}`;
  try {
    const existing = await host.reminders.list({ purpose, status: "armed" });
    if (existing.length > 0) {
      return;
    }
    await host.reminders.create({
      purpose,
      channelId: "observability",
      continuationToken: incidentContinuation(input.incidentId),
      delay: POLL,
      handler: cloudStopWatch,
      busyPolicy: "queueBehindTurn",
      args: {
        incidentId: input.incidentId,
        agentId: input.agentId,
        phase: input.phase,
        baselinePrUrl: input.baselinePrUrl ?? "",
        deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    });
  } catch (error) {
    console.warn(
      `[spike-detector] could not arm cloud stop watch: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
