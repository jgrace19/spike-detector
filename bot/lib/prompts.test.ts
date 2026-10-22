import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FRESH_FIX_RULE, fixPrompt, triagePrompt } from "./prompts.js";

const RULE = FRESH_FIX_RULE;

test("triage and fix prompts refuse existing pull requests", () => {
  const triage = triagePrompt({
    incidentId: "inc-1001",
    metric: "freshcart.checkout.gmv_cents",
    env: "prod",
    baseline: 100000,
    value: 68000,
    window: "30m",
  });
  const fix = fixPrompt({
    incidentId: "inc-1001",
    signoffNote: "approve",
    baseBranch: "production",
  });
  assert.match(triage, new RegExp(escapeRegExp(RULE)));
  assert.match(fix, new RegExp(escapeRegExp(RULE)));
});

test("instructions tell the agent to ignore unmerged pull requests", async () => {
  const instructions = await readFile(new URL("../instructions.md", import.meta.url), "utf8");
  assert.equal(instructions.includes(RULE), true);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
