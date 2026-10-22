import { defineEval, includes } from "@cursor/bdk/evals";
import { formatAlertPrompt } from "../bot/lib/prompts.js";

const incidentId = "exp-planned-gmv";

export default defineEval({
  tags: ["smoke", "expected"],
  description: "A GMV move explained by a planned promo is logged and not paged.",
  async test(t) {
    await t.send(
      formatAlertPrompt({
        incidentId,
        metric: "freshcart.checkout.gmv_cents",
        env: "prod",
        baseline: 100000,
        value: 108000,
        window: "2h",
      }),
    );
    t.succeeded();
    t.calledTool("list_recent_changes", { input: { incidentId } });
    t.calledTool("log_expected_change", { output: { decision: "expected" } });
    t.notCalledTool("record_bug");
    t.notCalledTool("launch_triage");
    t.notCalledTool("open_linear_issue");
    t.notCalledTool("page_code_owner");
    t.notCalledTool("request_fix");
    t.check(t.reply, includes(/decision:\s*expected/i));
  },
});
