import assert from "node:assert/strict";
import test from "node:test";
import {
  DEPLOY_HOOK_RETRIES,
  DEPLOY_HOOK_TIMEOUT_MS,
  DEPLOY_HOOK_URL_ENV,
  notifyDeployHook,
} from "./deploy-hook.js";

const body = {
  incidentId: "inc-1001",
  prNumber: 42,
  branch: "fix/checkout-pricing",
  headSha: "abc123",
};

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

test("an unset deploy hook does not call fetch", async () => {
  const previous = process.env[DEPLOY_HOOK_URL_ENV];
  delete process.env[DEPLOY_HOOK_URL_ENV];
  let calls = 0;
  try {
    const result = await notifyDeployHook(body, async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    });
    assert.deepEqual(result, { status: "skipped" });
    assert.equal(calls, 0);
  } finally {
    restoreEnv(DEPLOY_HOOK_URL_ENV, previous);
  }
});

test("a ship hook posts the recorded head and retries twice", async () => {
  const previousUrl = process.env[DEPLOY_HOOK_URL_ENV];
  const previousToken = process.env.OBSERVABILITY_SHARED_SECRET;
  process.env[DEPLOY_HOOK_URL_ENV] = "https://hooks.example.com/";
  process.env.OBSERVABILITY_SHARED_SECRET = "first-secret";
  const calls: Array<{ url: string; init: RequestInit }> = [];
  try {
    const sent = await notifyDeployHook(body, async (url, init) => {
      calls.push({ url, init });
      if (calls.length < DEPLOY_HOOK_RETRIES + 1) {
        return new Response("busy", { status: 503 });
      }
      return new Response(null, { status: 204 });
    });
    assert.deepEqual(sent, { status: "sent" });
    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.url, "https://hooks.example.com/api/ship-hook");
    const headers = new Headers(calls[0]?.init.headers);
    assert.equal(headers.get("X-Observability-Token"), "first-secret");
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(calls[0]?.init.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), body);
    assert.ok(calls[0]?.init.signal instanceof AbortSignal);

    process.env.OBSERVABILITY_SHARED_SECRET = "rotated-secret";
    calls.length = 0;
    await notifyDeployHook(body, async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 200 });
    });
    assert.equal(new Headers(calls[0]?.init.headers).get("X-Observability-Token"), "rotated-secret");
    assert.equal(DEPLOY_HOOK_TIMEOUT_MS, 10_000);
  } finally {
    restoreEnv(DEPLOY_HOOK_URL_ENV, previousUrl);
    restoreEnv("OBSERVABILITY_SHARED_SECRET", previousToken);
  }
});

test("a deploy hook that keeps failing reports the last error", async () => {
  const previousUrl = process.env[DEPLOY_HOOK_URL_ENV];
  process.env[DEPLOY_HOOK_URL_ENV] = "https://hooks.example.com";
  let calls = 0;
  try {
    const result = await notifyDeployHook(body, async () => {
      calls += 1;
      throw new Error("timed out");
    });
    assert.equal(calls, DEPLOY_HOOK_RETRIES + 1);
    assert.deepEqual(result, { status: "failed", reason: "timed out" });
  } finally {
    restoreEnv(DEPLOY_HOOK_URL_ENV, previousUrl);
  }
});
