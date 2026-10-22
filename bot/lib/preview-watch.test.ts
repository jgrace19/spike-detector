import assert from "node:assert/strict";
import test from "node:test";
import type { HostContext, HostKvApi, JsonValue, ReminderFireContext, ReminderInfo } from "@cursor/bdk";
import previewWatch, { PREVIEW_WATCH_DEADLINE_MS } from "../reminders/preview_watch.js";
import { putIncident, type IncidentRecord } from "./incidents.js";
import { armPreviewWatch } from "./watch.js";

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

function incident(patch: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    incidentId: "inc-1001",
    metric: "freshcart.checkout.gmv_cents",
    env: "prod",
    baseline: 100000,
    value: 68000,
    window: "30m",
    status: "bug",
    sessionStarted: true,
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...patch,
  };
}

test("preview watch stops at the deadline and when the incident is closed", async () => {
  const kv = memoryKv();
  await putIncident(kv, incident());
  const host = { kv } as HostContext;
  const reasons: Array<string | undefined> = [];
  let followed = 0;
  const fire = (args: Record<string, unknown>) =>
    previewWatch.run({
      args,
      host,
      async cancel(reason?: string) {
        reasons.push(reason);
      },
      async followup() {
        followed += 1;
        return { id: "session" };
      },
    } as unknown as ReminderFireContext);

  const expired = await fire({
    incidentId: "inc-1001",
    env: "preview-42",
    prNumber: 42,
    deadline: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(expired.action, "stop");
  assert.deepEqual(reasons, ["watch deadline"]);
  assert.equal(followed, 0);

  await putIncident(kv, incident({ status: "closed" }));
  const closed = await fire({
    incidentId: "inc-1001",
    env: "preview-42",
    prNumber: 42,
    deadline: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(closed.action, "stop");
  assert.deepEqual(reasons, ["watch deadline", "incident closed"]);
  assert.equal(followed, 0);
});

test("arming a preview watch sets a deadline about 45 minutes out", async () => {
  const kv = memoryKv();
  await putIncident(kv, incident());
  let deadline = "";
  const host = {
    kv,
    reminders: {
      async list() {
        return [];
      },
      async create(input: { args?: { deadline?: string } }) {
        deadline = input.args?.deadline ?? "";
        return { id: "rem-preview" } as ReminderInfo;
      },
    },
  } as unknown as HostContext;
  const armed = await armPreviewWatch(host, {
    incidentId: "inc-1001",
    prNumber: 42,
    metric: "freshcart.checkout.gmv_cents",
  });
  assert.equal(armed.armed, true);
  const remaining = Date.parse(deadline) - Date.now();
  assert.ok(remaining > PREVIEW_WATCH_DEADLINE_MS - 5_000);
  assert.ok(remaining < PREVIEW_WATCH_DEADLINE_MS + 5_000);
});
