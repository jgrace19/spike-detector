import { getCloudAgent } from "@cursor/bdk/extensions/cursor-cloud-agents";
import { defineReminder } from "@cursor/bdk/reminders";
import { publishCloudStop } from "../lib/cloud-stop.js";
import { fixStopReady, triageStopReady } from "../lib/cloud-watch-ready.js";

const SEEN_RUNNING = "cloud-watch-running:";

/**
 * Posts the triage card or the pull request link without a model turn.
 * Reschedules every 20s until the run stops or the deadline passes.
 * The extension's `[cloud agent stopped]` wake still arrives; that post
 * is the same idempotent call.
 */
export default defineReminder({
  async run({ args, host }) {
    const incidentId = typeof args.incidentId === "string" ? args.incidentId : "";
    const agentId = typeof args.agentId === "string" ? args.agentId : "";
    const phase = args.phase === "fix" ? "fix" : "triage";
    const baselinePrUrl = typeof args.baselinePrUrl === "string" ? args.baselinePrUrl : "";
    const deadline = typeof args.deadline === "string" ? Date.parse(args.deadline) : Number.NaN;
    if (incidentId === "" || agentId === "") {
      return { action: "stop" };
    }
    if (Number.isFinite(deadline) && Date.now() >= deadline) {
      return { action: "stop" };
    }
    let status = "unknown";
    let prUrl: string | undefined;
    let summary: string | undefined;
    let error: string | undefined;
    try {
      const info = await getCloudAgent(agentId);
      status = info.status;
      prUrl = info.prUrl;
      summary = info.summary;
      error = info.error;
    } catch {
      return { action: "skip", reschedule: { delay: "20s" } };
    }
    const seenKey = `${SEEN_RUNNING}${incidentId}`;
    if (phase === "fix" && (status === "running" || status === "creating")) {
      await host.kv.put(seenKey, true);
      return { action: "skip", reschedule: { delay: "20s" } };
    }
    const seenRunning = (await host.kv.get(seenKey)) === true;
    const ready =
      phase === "fix"
        ? fixStopReady({ status, prUrl, baselinePrUrl, seenRunning })
        : triageStopReady(status);
    if (!ready) {
      return { action: "skip", reschedule: { delay: "20s" } };
    }
    await publishCloudStop({
      host,
      incidentId,
      hint: { status, prUrl, summary, error },
    });
    if (phase === "fix") {
      await host.kv.delete(seenKey);
    }
    return { action: "stop" };
  },
});
