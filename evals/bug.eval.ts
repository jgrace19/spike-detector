import { defineEval, includes } from "@cursor/bdk/evals";
import { formatAlertPrompt } from "../bot/lib/prompts.js";

const incidentId = "bug-checkout-undercharge";

export default defineEval({
  tags: ["smoke", "bug"],
  description:
    "A checkout revenue drop with flat order volume is recorded as a bug and an alert is posted.",
  async test(t) {
    await t.send(
      [
        formatAlertPrompt({
          incidentId,
          metric: "freshcart.checkout.gmv_cents",
          env: "prod",
          baseline: 100000,
          value: 68000,
          window: "30m",
        }),
        "Sibling snapshots in the same window:",
        "freshcart.checkout.orders baseline 400 value 398",
        "freshcart.checkout.units baseline 900 value 905",
        "freshcart.checkout.average_order_value_cents baseline 250 value 170",
      ].join("\n"),
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
