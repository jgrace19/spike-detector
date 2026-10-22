import assert from "node:assert/strict";
import test from "node:test";
import type { HostContext, HostKvApi, JsonValue } from "@cursor/bdk";
import { catchAuthDeclaration } from "@cursor/bdk/channels";
import observability from "../channels/observability.js";
import { getIncident, putIncident, type IncidentRecord } from "./incidents.js";
import { resetObservability } from "./reset.js";
import { getShipped, putShipped } from "./shipped.js";

function memoryKv(): HostKvApi {
  const store = new Map<string, JsonValue>();
  return {
    async get(key) {
      return store.has(key) ? structuredClone(store.get(key)) : undefined;
    },
    async put(key, value) {
      store.set(key, structuredClone(value));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function incident(patch: Partial<IncidentRecord>): IncidentRecord {
  return {
    incidentId: "inc-open",
    metric: "freshcart.checkout.gmv_cents",
    env: "prod",
    baseline: 100000,
    value: 68000,
    window: "30m",
    status: "bug",
    sessionStarted: true,
    updatedAt: "2026-10-22T00:00:00.000Z",
    previewReminderId: "rem-preview",
    ...patch,
  };
}

test("shipped route lists unresolved ships and reset clears them", async () => {
  const kv = memoryKv();
  const cancelled: string[] = [];
  await putIncident(kv, incident({ incidentId: "inc-open", previewReminderId: "rem-open" }));
  await putIncident(kv, incident({ incidentId: "inc-done", status: "closed", previewReminderId: "rem-done" }));
  await putShipped(kv, {
    incidentId: "inc-open",
    prNumber: 42,
    threadTs: "100.1",
    shippedAt: "2026-10-22T01:00:00.000Z",
    branch: "fix/checkout-pricing",
    headSha: "abc123",
    prUrl: "https://github.com/jgrace19/marketplace/pull/42",
  });
  await putShipped(kv, {
    incidentId: "inc-done",
    prNumber: 9,
    threadTs: "200.1",
    shippedAt: "2026-10-22T02:00:00.000Z",
    branch: "fix/other",
    headSha: "fff",
  });
  const host = {
    kv,
    reminders: {
      async cancel(id: string) {
        cancelled.push(id);
        return undefined;
      },
      async cancelForContinuation() {
        return 0;
      },
    },
  } as unknown as HostContext;

  const shippedRoute = observability.routes?.find((route) => route.method === "GET" && route.path === "/shipped");
  const resetRoute = observability.routes?.find((route) => route.method === "POST" && route.path === "/reset");
  assert.ok(shippedRoute);
  assert.ok(resetRoute);
  const auth = (observability.auth ?? []).map((policy) => catchAuthDeclaration(policy));
  assert.deepEqual(auth, [
    { kind: "header", header: "x-observability-token", secret: "OBSERVABILITY_SHARED_SECRET" },
  ]);

  const listed = await shippedRoute.handler(new Request("http://127.0.0.1/v1/channels/observability/shipped"), {
    host,
  } as never);
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), {
    items: [
      {
        incidentId: "inc-open",
        prNumber: 42,
        branch: "fix/checkout-pricing",
        headSha: "abc123",
        shippedAt: "2026-10-22T01:00:00.000Z",
      },
    ],
  });

  const resetResponse = await resetRoute.handler(new Request("http://127.0.0.1/v1/channels/observability/reset"), {
    host,
  } as never);
  assert.equal(resetResponse.status, 200);
  const body = (await resetResponse.json()) as { ok: boolean; closed: string[]; cleared: string[] };
  assert.equal(body.ok, true);
  assert.deepEqual(body.closed.sort(), ["inc-done", "inc-open"]);
  assert.deepEqual(body.cleared.sort(), ["inc-done", "inc-open"]);
  assert.deepEqual(cancelled, ["rem-open"]);
  assert.equal(await getIncident(kv, "inc-open"), undefined);
  assert.equal(await getIncident(kv, "inc-done"), undefined);
  assert.equal(await getShipped(kv, "inc-open"), undefined);

  const after = await shippedRoute.handler(new Request("http://127.0.0.1/v1/channels/observability/shipped"), {
    host,
  } as never);
  assert.deepEqual(await after.json(), { items: [] });

  const direct = await resetObservability(host);
  assert.deepEqual(direct, { ok: true, closed: [], cleared: [] });
});
