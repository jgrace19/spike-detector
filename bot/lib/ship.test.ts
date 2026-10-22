import assert from "node:assert/strict";
import test from "node:test";
import type { HostContext, HostKvApi, JsonValue } from "@cursor/bdk";
import { announceKnownPullRequest } from "./cloud-stop.js";
import { putIncident, updateIncident, type IncidentRecord } from "./incidents.js";
import {
  handleProductionRecovery,
  isProductionEnv,
  observabilityAlertDecision,
  observabilityAlertSchema,
} from "./recovery.js";
import { handleSlackReaction } from "../channels/slack.js";
import { SHIP_FAILED_TEXT, SHIP_REVIEW_TEXT, SHIPPING_TEXT, shipReviewSummary } from "./slack-cards.js";
import { rememberSlackMessage } from "./slack-index.js";
import { handleShipReaction, shipApprovalComment } from "./ship.js";
import { getShipped, putShipped, shippedKey } from "./shipped.js";

process.env.SPIKE_DETECTOR_CODE_OWNER_SLACK_ID = "UOWNER";

const PR_URL = "https://github.com/jgrace19/marketplace/pull/42";

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

const HEAD_BRANCH = "fix/checkout-pricing";
const HEAD_SHA = "abc123deadbeef";

type GitHubDouble = {
  octokit: {
    rest: {
      issues: {
        createLabel: () => Promise<void>;
        addLabels: (params: { labels: string[] }) => Promise<void>;
        listComments: () => Promise<{ data: { body: string }[] }>;
        createComment: (params: { body: string }) => Promise<void>;
      };
      pulls: {
        get: () => Promise<{ data: { head: { ref: string; sha: string } } }>;
      };
    };
  };
  labels: string[];
  comments: string[];
  failCreateLabel: (error: unknown) => void;
  failWrites: (error: unknown) => void;
  failHeadRead: (error: unknown) => void;
};

function fakeGitHub(): GitHubDouble {
  const labels: string[] = [];
  const comments: string[] = [];
  let createLabelError: unknown;
  let writeError: unknown;
  let headError: unknown;
  return {
    labels,
    comments,
    failCreateLabel(error: unknown) {
      createLabelError = error;
    },
    failWrites(error: unknown) {
      writeError = error;
    },
    failHeadRead(error: unknown) {
      headError = error;
    },
    octokit: {
      rest: {
        pulls: {
          async get() {
            if (headError !== undefined) {
              throw headError;
            }
            return { data: { head: { ref: HEAD_BRANCH, sha: HEAD_SHA } } };
          },
        },
        issues: {
          async createLabel() {
            if (createLabelError !== undefined) {
              throw createLabelError;
            }
            if (writeError !== undefined) {
              throw writeError;
            }
          },
          async addLabels({ labels: names }: { labels: string[] }) {
            if (writeError !== undefined) {
              throw writeError;
            }
            labels.push(...names);
          },
          async listComments() {
            return { data: comments.map((body) => ({ body })) };
          },
          async createComment({ body }: { body: string }) {
            if (writeError !== undefined) {
              throw writeError;
            }
            comments.push(body);
          },
        },
      },
    },
  };
}

async function withWarnings(run: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((part) => String(part)).join(" "));
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return warnings;
}

function fakeHost(kv: HostKvApi, github = fakeGitHub()): {
  host: HostContext;
  posts: Array<Record<string, unknown>>;
  github: GitHubDouble;
} {
  const posts: Array<Record<string, unknown>> = [];
  const host = {
    kv,
    slack: {
      getClient: async () => ({
        chat: {
          postMessage: async (args: Record<string, unknown>) => {
            posts.push(args);
            return { ok: true, ts: `${200 + posts.length}.5`, channel: "C1" };
          },
          update: async () => ({ ok: true }),
        },
        users: {
          info: async () => ({
            user: { name: "ada", profile: { display_name: "Ada Lovelace" } },
          }),
        },
        reactions: { add: async () => ({ ok: true }) },
      }),
    },
    github: { getOctokit: async () => github.octokit },
    mcp: {
      names: () => ["linear"],
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
    },
  } as unknown as HostContext;
  return { host, posts, github };
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
    slackChannelId: "C1",
    slackThreadTs: "100.1",
    triageSlackTs: "100.2",
    prNumber: 42,
    prUrl: PR_URL,
    linearIssueId: "FC-1",
    linearIssueUrl: "https://linear.app/fe-demo/issue/FC-1",
    triageReport: "Root cause: Multi-quantity orders are undercharged.",
    ...patch,
  };
}

function recoveryBody(patch: Record<string, unknown> = {}) {
  return observabilityAlertSchema.parse({
    incidentId: "inc-1001",
    metric: "freshcart.checkout.gmv_cents",
    env: "prod",
    baseline: 100000,
    value: 98000,
    window: "30m",
    status: "recovered",
    gmv: { value: 98000, baseline: 100000, previous: 68000 },
    aov: { value: 4400, baseline: 4500, previous: 3100 },
    ...patch,
  });
}

test("recovery status does not look like an anomaly", () => {
  assert.equal(observabilityAlertDecision(undefined), "triage");
  assert.equal(observabilityAlertDecision(null), "triage");
  assert.equal(observabilityAlertDecision("firing"), "triage");
  assert.equal(observabilityAlertDecision("not_recovered"), "triage");
  assert.equal(observabilityAlertDecision("Recovered"), "recovery");
  assert.equal(observabilityAlertDecision(" resolved "), "recovery");
  const anomaly = observabilityAlertSchema.parse({
    incidentId: "inc-1001",
    metric: "freshcart.checkout.gmv_cents",
    env: "prod",
    baseline: 100000,
    value: 68000,
    window: "30m",
  });
  assert.equal(anomaly.status, undefined);
  assert.equal(isProductionEnv("prod"), true);
  assert.equal(isProductionEnv("demo/base"), true);
  assert.equal(isProductionEnv("preview-42"), false);
});

test("review summary drops internal names", () => {
  const summary = shipReviewSummary(
    "Root cause: datacat saw demo/base\nReal cause is the pricing function",
  );
  assert.equal(summary, "Real cause is the pricing function");
  assert.doesNotMatch(summary, /datacat|demo\/base/i);
});

test("pull request link is followed by the ship review card", async () => {
  const kv = memoryKv();
  await putIncident(kv, incident({ prUrl: undefined, prNumber: undefined }));
  const { host, posts } = fakeHost(kv);
  const first = await announceKnownPullRequest(host, "inc-1001", PR_URL);
  assert.equal(first.posted, true);
  assert.equal(posts.length, 2);
  assert.match(String(posts[0]?.text), /pull request/i);
  assert.match(String(posts[1]?.text), /Fix is ready for review/);
  assert.match(String(posts[1]?.text), new RegExp(SHIP_REVIEW_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(JSON.stringify(posts[1]?.blocks), /<@UOWNER>/);
  assert.match(JSON.stringify(posts[1]?.blocks), /marketplace\/pull\/42/);
  assert.doesNotMatch(JSON.stringify(posts[1]), /datacat|demo\/base/i);
  const stored = await kv.get("incident:inc-1001");
  assert.equal(typeof stored === "object" && stored !== null && "shipReviewSlackTs" in stored, true);
  const second = await announceKnownPullRequest(host, "inc-1001", PR_URL);
  assert.equal(second.already, true);
  assert.equal(posts.length, 2);
});

test("rocket on the review message labels the pull request once", async () => {
  const kv = memoryKv();
  await putIncident(kv, incident({ shipReviewSlackTs: "100.3" }));
  await rememberSlackMessage(kv, "100.3", { incidentId: "inc-1001", role: "ship_review" });
  await rememberSlackMessage(kv, "100.2", { incidentId: "inc-1001", role: "triage" });
  const { host, posts, github } = fakeHost(kv);

  const ignored = await handleShipReaction(host, {
    threadTs: "100.2",
    channelId: "C1",
    reaction: { name: "rocket" },
    author: { userId: "UADA" },
  });
  assert.equal(ignored.status, "ignored");
  assert.equal(github.comments.length, 0);
  await handleSlackReaction(host, {
    threadTs: "100.2",
    channelId: "C1",
    reaction: { name: "rocket" },
    author: { userId: "UADA" },
  });
  assert.equal(posts.length, 0);

  const shipped = await handleShipReaction(host, {
    threadTs: "100.3",
    channelId: "C1",
    reaction: { name: "rocket" },
    author: { userId: "UADA" },
  });
  assert.equal(shipped.status, "shipped");
  assert.deepEqual(github.labels, ["ship"]);
  assert.deepEqual(github.comments, [shipApprovalComment("Ada Lovelace")]);
  assert.equal(github.comments[0], "Approved for production by @Ada Lovelace via Slack");
  assert.equal(posts.filter((post) => post.text === SHIPPING_TEXT).length, 1);
  const record = await getShipped(kv, "inc-1001");
  assert.equal(record?.prNumber, 42);
  assert.equal(record?.threadTs, "100.1");
  assert.equal(record?.linearIssueId, "FC-1");
  assert.equal(record?.branch, HEAD_BRANCH);
  assert.equal(record?.headSha, HEAD_SHA);
  assert.equal(record?.prUrl, PR_URL);
  assert.equal(await kv.get(shippedKey("inc-1001")) !== undefined, true);

  const again = await handleShipReaction(host, {
    threadTs: "100.3",
    channelId: "C1",
    reaction: { name: "rocket" },
    author: { userId: "UADA" },
  });
  assert.equal(again.status, "already");
  assert.equal(github.comments.length, 1);
  assert.equal(posts.filter((post) => post.text === SHIPPING_TEXT).length, 1);
});

test("an existing ship label is reused and a failed write still ships", async () => {
  const kv = memoryKv();
  await putIncident(kv, incident({ incidentId: "inc-label", shipReviewSlackTs: "100.3" }));
  await rememberSlackMessage(kv, "100.3", { incidentId: "inc-label", role: "ship_review" });
  const { host, posts, github } = fakeHost(kv);
  github.failCreateLabel(
    Object.assign(new Error("Label already exists"), {
      status: 422,
      response: { data: { errors: [{ code: "already_exists" }] } },
    }),
  );
  const shipped = await handleShipReaction(host, {
    threadTs: "100.3",
    channelId: "C1",
    reaction: { name: "rocket" },
    author: { userId: "UADA", userName: "ada" },
  });
  assert.equal(shipped.status, "shipped");
  assert.deepEqual(github.labels, ["ship"]);
  assert.equal(github.comments[0], "Approved for production by @ada via Slack");

  const kv2 = memoryKv();
  await putIncident(kv2, incident({ incidentId: "inc-fail", shipReviewSlackTs: "100.9" }));
  await rememberSlackMessage(kv2, "100.9", { incidentId: "inc-fail", role: "ship_review" });
  const second = fakeHost(kv2);
  second.github.failWrites(Object.assign(new Error("Resource not accessible by integration"), { status: 403 }));
  const warnings = await withWarnings(async () => {
    const failed = await handleSlackReaction(second.host, {
      threadTs: "100.9",
      channelId: "C1",
      reaction: { name: "rocket" },
      author: { userId: "UADA" },
    });
    assert.equal(failed, undefined);
  });
  assert.match(warnings.join("\n"), /ship label failed/);
  assert.match(warnings.join("\n"), /ship comment failed/);
  assert.doesNotMatch(warnings.join("\n"), /ship failed:/);
  assert.equal(second.github.comments.length, 0);
  assert.equal(second.github.labels.length, 0);
  assert.equal(second.posts.filter((post) => post.text === SHIPPING_TEXT).length, 1);
  assert.equal(second.posts.some((post) => post.text === SHIP_FAILED_TEXT), false);
  const recorded = await getShipped(kv2, "inc-fail");
  assert.equal(recorded?.prNumber, 42);
  assert.equal(recorded?.branch, HEAD_BRANCH);
  assert.equal(recorded?.headSha, HEAD_SHA);
  assert.equal(recorded?.prUrl, PR_URL);
  assert.equal(posts.length >= 1, true);
});

test("recovery closes a shipped incident once and never starts triage", async () => {
  const kv = memoryKv();
  await putIncident(kv, incident({ shipReviewSlackTs: "100.3", shippedAt: "2026-10-22T01:00:00.000Z" }));
  const { host, posts } = fakeHost(kv);
  await putShipped(kv, {
    incidentId: "inc-1001",
    prNumber: 42,
    prUrl: PR_URL,
    threadTs: "100.1",
    channelId: "C1",
    linearIssueId: "FC-1",
    linearIssueUrl: "https://linear.app/fe-demo/issue/FC-1",
    shippedAt: "2026-10-22T01:00:00.000Z",
  });
  const closedIds: string[] = [];
  const closeIssue = async (_mcp: HostContext["mcp"], input: { identifier: string }) => {
    closedIds.push(input.identifier);
    return { ok: true as const, identifier: input.identifier };
  };

  const unshipped = memoryKv();
  await putIncident(unshipped, incident());
  const early = await handleProductionRecovery(fakeHost(unshipped).host, recoveryBody(), { closeIssue });
  assert.equal(early.reason, "not_shipped");
  assert.equal(early.closed, false);
  assert.deepEqual(closedIds, []);

  const outside = await handleProductionRecovery(
    host,
    recoveryBody({
      gmv: { value: 111000, baseline: 100000 },
      aov: { value: 4400, baseline: 4500 },
    }),
    { closeIssue },
  );
  assert.equal(outside.reason, "not_recovered");
  assert.deepEqual(closedIds, []);

  const preview = await handleProductionRecovery(host, recoveryBody({ env: "preview-42" }), { closeIssue });
  assert.equal(preview.reason, "not_production");

  const closed = await handleProductionRecovery(host, recoveryBody({ status: "resolved" }), { closeIssue });
  assert.equal(closed.closed, true);
  assert.deepEqual(closedIds, ["FC-1"]);
  const resolution = posts.at(-1);
  const rendered = JSON.stringify(resolution);
  assert.match(rendered, /68,000/);
  assert.match(rendered, /98,000/);
  assert.match(rendered, /3,100/);
  assert.match(rendered, /4,400/);
  assert.match(rendered, /pull\/42/);
  assert.match(rendered, /FC-1/);
  assert.match(rendered, /white_check_mark|Resolved/);
  assert.doesNotMatch(rendered, /datacat|demo\/base/i);
  const after = await kv.get("incident:inc-1001");
  assert.equal(typeof after === "object" && after !== null && "status" in after && after.status, "closed");

  const repeat = await handleProductionRecovery(host, recoveryBody(), { closeIssue });
  assert.equal(repeat.already, true);
  assert.equal(posts.length, 1);
  assert.deepEqual(closedIds, ["FC-1"]);
});

test("a partial ship retries the record without a second shipping line", async () => {
  const kv = memoryKv();
  await putIncident(kv, incident({ incidentId: "inc-retry", shipReviewSlackTs: "100.3" }));
  await rememberSlackMessage(kv, "100.3", { incidentId: "inc-retry", role: "ship_review" });
  const { host, posts, github } = fakeHost(kv);
  const react = () =>
    handleShipReaction(host, {
      threadTs: "100.3",
      channelId: "C1",
      reaction: { name: "rocket" },
      author: { userName: "ada", userId: "UADA" },
    });
  assert.equal((await react()).status, "shipped");
  await updateIncident(kv, "inc-retry", { shippedAt: undefined });
  const { delete: remove } = kv;
  await remove(shippedKey("inc-retry"));
  assert.equal((await react()).status, "shipped");
  assert.equal(github.comments.length, 1);
  assert.equal(posts.filter((post) => post.text === SHIPPING_TEXT).length, 1);
  assert.equal((await getShipped(kv, "inc-retry"))?.threadTs, "100.1");
});

test("a failed head read falls back to the stored branch and sha", async () => {
  const kv = memoryKv();
  await putIncident(
    kv,
    incident({
      incidentId: "inc-head",
      shipReviewSlackTs: "100.3",
      headBranch: "stored/fix",
      headSha: "storedsha",
    }),
  );
  await rememberSlackMessage(kv, "100.3", { incidentId: "inc-head", role: "ship_review" });
  const { host, posts, github } = fakeHost(kv);
  github.failHeadRead(new Error("Not Found"));
  const warnings = await withWarnings(async () => {
    const shipped = await handleShipReaction(host, {
      threadTs: "100.3",
      channelId: "C1",
      reaction: { name: "rocket" },
      author: { userId: "UADA", userName: "ada" },
    });
    assert.equal(shipped.status, "shipped");
  });
  assert.match(warnings.join("\n"), /pull request head read failed/);
  const record = await getShipped(kv, "inc-head");
  assert.equal(record?.branch, "stored/fix");
  assert.equal(record?.headSha, "storedsha");
  assert.equal(posts.filter((post) => post.text === SHIPPING_TEXT).length, 1);
  assert.equal(github.labels.length, 1);
});

test("a ship that cannot start posts a note in the thread", async () => {
  const kv = memoryKv();
  await putIncident(kv, incident({ incidentId: "inc-nopr", prNumber: undefined, shipReviewSlackTs: "100.3" }));
  await rememberSlackMessage(kv, "100.3", { incidentId: "inc-nopr", role: "ship_review" });
  const { host, posts } = fakeHost(kv);
  const warnings = await withWarnings(async () => {
    await handleSlackReaction(host, {
      threadTs: "100.3",
      channelId: "C1",
      reaction: { name: "rocket" },
      author: { userId: "UADA" },
    });
  });
  assert.match(warnings.join("\n"), /ship failed: no_pull_request/);
  assert.equal(posts.filter((post) => post.text === SHIP_FAILED_TEXT).length, 1);
  assert.equal(posts.some((post) => post.thread_ts === "100.1"), true);
  assert.equal(await getShipped(kv, "inc-nopr"), undefined);
});
