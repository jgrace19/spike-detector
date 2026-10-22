import assert from "node:assert/strict";
import test from "node:test";
import type { HostContext, HostKvApi, JsonValue } from "@cursor/bdk";
import { catchAuthDeclaration } from "@cursor/bdk/channels";
import { dispatchOutcome } from "../../node_modules/@cursor/bdk/dist/internal/channel-dispatch.js";
import { replayCatchRequest } from "../../node_modules/@cursor/bdk/dist/internal/hosted-catch.js";
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
    recoveries: {},
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
  assert.deepEqual(await after.json(), { items: [], recoveries: {} });

  const direct = await resetObservability(host);
  assert.deepEqual(direct, { ok: true, closed: [], cleared: [] });
});

test("a hosted reset replay with admin:reset clears state and does not start triage", async () => {
  const kv = memoryKv();
  await putIncident(kv, incident({ incidentId: "inc-open", previewReminderId: "rem-open" }));
  await putShipped(kv, {
    incidentId: "inc-open",
    prNumber: 42,
    threadTs: "100.1",
    shippedAt: "2026-10-22T01:00:00.000Z",
    branch: "fix/checkout-pricing",
    headSha: "abc123",
  });
  const sends: string[] = [];
  const host = {
    kv,
    reminders: {
      async cancel() {
        return undefined;
      },
      async cancelForContinuation() {
        return 0;
      },
    },
  } as unknown as HostContext;
  const response = await replayCatchRequest({
    channelId: "observability",
    deliveryId: "dlv_reset",
    routes: observability.routes ?? [],
    payload: {
      v: 1,
      method: "POST",
      path: "/reset",
      query: "",
      headers: {
        "content-type": "application/json",
        "x-bdk-session-key": "admin:reset",
        "x-observability-token": "secret",
      },
      body: {
        encoding: "utf8",
        data: JSON.stringify({
          incidentId: "inc-open",
          metric: "freshcart.checkout.gmv_cents",
          env: "prod",
          baseline: 100000,
          value: 68000,
          window: "30m",
        }),
      },
      receivedAt: "2026-10-22T12:00:00.000Z",
    },
    args: {
      host,
      async send(message: string) {
        sends.push(message);
        throw new Error("reset must not start a turn");
      },
      waitUntil() {},
    } as never,
  });
  assert.equal(response.ok, true);
  assert.equal(dispatchOutcome(response), "skip");
  assert.deepEqual(sends, []);
  assert.equal(await getIncident(kv, "inc-open"), undefined);
  assert.equal(await getShipped(kv, "inc-open"), undefined);
  const body = (await response.json()) as { ok?: boolean };
  assert.equal(body.ok, true);
});
