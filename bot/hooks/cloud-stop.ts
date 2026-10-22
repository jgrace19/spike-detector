import { defineHook } from "@cursor/bdk/hooks";
import { hintFromInfo, publishCloudStop } from "../lib/cloud-stop.js";
import { incidentIdFromContinuation, parseStopWake } from "../lib/public-text.js";

/**
 * The cloud extension wakes the incident session with `[cloud agent stopped]`.
 * Post the Slack triage card or the pull request link here, so it does not
 * wait for a person to speak in the thread.
 */
export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      if (ctx.session.purpose === "eval" || ctx.channel.id !== "observability") {
        return;
      }
      const parsed = parseStopWake(event.data.text);
      if (parsed === undefined) {
        return;
      }
      const incidentId = incidentIdFromContinuation(ctx.channel.continuationToken);
      if (incidentId === undefined) {
        return;
      }
      try {
        await publishCloudStop({
          host: ctx.host,
          incidentId,
          hint: { ...hintFromInfo(parsed.info), status: parsed.status },
        });
      } catch (error) {
        console.warn(
          `[spike-detector] cloud stop post failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  },
});
