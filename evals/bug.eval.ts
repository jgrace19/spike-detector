import { defineEval, includes } from "@cursor/bdk/evals";
import { formatAlertPrompt } from "../bot/lib/prompts.js";

const incidentId = "bug-latency-spike";

export default defineEval({
  tags: ["smoke", "bug"],
  description: "An unexplained latency spike is recorded as a bug and paged.",
  async test(t) {
    await t.send(
      formatAlertPrompt({
        incidentId,
        metric: "checkout_p95_ms",
        env: "prod",
        baseline: 200,
        value: 1800,
        window: "30m",
      }),
    );
    t.succeeded();
    t.calledTool("list_recent_changes", { input: { incidentId } });
    t.calledTool("record_bug", { output: { decision: "bug" } });
    t.calledTool("launch_triage");
    t.calledTool("open_linear_issue");
    t.calledTool("page_code_owner");
    t.notCalledTool("log_expected_change");
    t.notCalledTool("request_fix");
    t.notCalledTool("close_incident");
    t.check(t.reply, includes(/decision:\s*bug/i));
  },
});
