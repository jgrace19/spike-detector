import assert from "node:assert/strict";
import test from "node:test";
import { alertPayload, triagePayload } from "./slack-cards.js";
import { fixStopReady } from "./cloud-watch-ready.js";
import { isApprovalReply, parseStopWake, severityLabel } from "./public-text.js";
import { parseTriageReport, reportAsPlan } from "./triage-report.js";
import type { IncidentRecord } from "./incidents.js";

const incident: IncidentRecord = {
  incidentId: "inc-1001",
  metric: "freshcart.checkout.gmv_cents",
  env: "prod",
  baseline: 3501,
  value: 2376,
  window: "30m",
  status: "bug",
  sessionStarted: true,
  updatedAt: "2026-10-22T00:00:00.000Z",
  cloudAgentUrl: "https://cursor.com/agents/bc-test",
  linearIssueUrl: "https://linear.app/fe-demo/issue/FC-1",
  linearIssueId: "FC-1",
};

test("alert card asks for nothing and does not mention the owner", () => {
  const payload = alertPayload(incident);
  assert.match(payload.text, /incident:inc-1001/);
  assert.match(payload.text, /32% drop/);
  assert.match(payload.text, /No action needed/);
  assert.doesNotMatch(payload.text, /<@/);
  assert.doesNotMatch(payload.text, /sign-off|signed off|approve/i);
  assert.doesNotMatch(JSON.stringify(payload.blocks), /demo\/base|mock metrics/);
  const header = payload.blocks[0];
  assert.equal(header?.type, "header");
  assert.match(JSON.stringify(header), /rotating_light/);
  assert.match(JSON.stringify(header), /SEV-2/);
});

test("triage card mentions the owner and links the commit", () => {
  const payload = triagePayload({
    incident,
    ownerId: "U123",
    report: parseTriageReport(`
\`\`\`incident-report
root_cause: Multi-quantity orders are undercharged.
commit_sha: d4b5255abc
commit_message: Adjust checkout pricing
file: src/checkout.ts
function: priceLine
impact: Multi-quantity orders undercharged
confidence: high
plan:
- Charge each unit
- Add a regression test
\`\`\`
`),
  });
  assert.match(payload.text, /<@U123>/);
  assert.match(payload.text, /React 👍 to approve the fix/);
  assert.match(JSON.stringify(payload.blocks), /github.com\/jgrace19\/marketplace\/commit\/d4b5255abc/);
  assert.match(JSON.stringify(payload.blocks), /approve_incident_fix/);
  assert.doesNotMatch(JSON.stringify(payload.blocks), /demo\/base/);
});

test("approval replies are exact and questions are not", () => {
  assert.equal(isApprovalReply("approve"), true);
  assert.equal(isApprovalReply("LGTM"), true);
  assert.equal(isApprovalReply("ship it"), true);
  assert.equal(isApprovalReply("<@U1> approve"), true);
  assert.equal(isApprovalReply("signed off incident:inc-1001"), true);
  assert.equal(isApprovalReply("can you approve?"), false);
  assert.equal(isApprovalReply("I think we should approve the pricing change later"), false);
});

test("stop wake parses the agent id and info", () => {
  const parsed = parseStopWake(
    `[cloud agent stopped] bc-1 is finished.\n${JSON.stringify({ prUrl: "https://github.com/jgrace19/marketplace/pull/9", summary: "done" })}`,
  );
  assert.equal(parsed?.agentId, "bc-1");
  assert.equal(parsed?.status, "finished");
  assert.equal(parsed?.info.prUrl, "https://github.com/jgrace19/marketplace/pull/9");
});

test("fix watch does not treat the triage stop as the fix stop", () => {
  assert.equal(
    fixStopReady({ status: "finished", baselinePrUrl: "", seenRunning: false }),
    false,
  );
  assert.equal(
    fixStopReady({
      status: "finished",
      prUrl: "https://github.com/jgrace19/marketplace/pull/9",
      baselinePrUrl: "",
      seenRunning: false,
    }),
    true,
  );
  assert.equal(
    fixStopReady({ status: "finished", baselinePrUrl: "", seenRunning: true }),
    true,
  );
});

test("severity and plan scrub", () => {
  assert.equal(severityLabel("drop", 32), "SEV-2");
  const plan = reportAsPlan(
    parseTriageReport("root_cause: only on a demo branch\nreal cause is the pricing function"),
  );
  assert.doesNotMatch(plan, /demo branch/);
  const scrubbed = reportAsPlan(
    parseTriageReport("root_cause: datacat flagged demo/base\nreal cause is the pricing function"),
  );
  assert.doesNotMatch(scrubbed, /datacat|demo\/base/i);
});
