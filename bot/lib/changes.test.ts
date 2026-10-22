import assert from "node:assert/strict";
import test from "node:test";
import type { HostGitHubClient } from "@cursor/bdk";
import { listChanges } from "./changes.js";

test("listChanges returns merged pull requests and drops unmerged ones", async () => {
  const now = new Date().toISOString();
  let state = "";
  const github = {
    async getOctokit() {
      return {
        rest: {
          repos: {
            async listCommits() {
              return { data: [] };
            },
          },
          pulls: {
            async list(params: { state: string }) {
              state = params.state;
              return {
                data: [
                  {
                    number: 7,
                    title: "Open fix",
                    body: "still open",
                    html_url: "https://github.com/jgrace19/marketplace/pull/7",
                    updated_at: now,
                    merged_at: null,
                  },
                  {
                    number: 8,
                    title: "Merged fix",
                    body: "merged",
                    html_url: "https://github.com/jgrace19/marketplace/pull/8",
                    updated_at: now,
                    merged_at: now,
                  },
                ],
              };
            },
          },
        },
      };
    },
  };
  const listed = await listChanges({
    incidentId: "inc-1001",
    window: "30m",
    purpose: "live",
    github: github as unknown as HostGitHubClient,
  });
  assert.equal(listed.ok, true);
  if (!listed.ok) {
    return;
  }
  assert.equal(state, "closed");
  assert.deepEqual(
    listed.pulls.map((pull) => pull.number),
    [8],
  );
  assert.equal(listed.pulls[0]?.merged, true);
});

test("eval fixtures omit unmerged pull requests", async () => {
  const listed = await listChanges({
    incidentId: "mixed-prs",
    window: "30m",
    purpose: "eval",
    github: { getOctokit: async () => { throw new Error("unused"); } } as unknown as HostGitHubClient,
  });
  assert.equal(listed.ok, true);
  if (!listed.ok) {
    return;
  }
  assert.deepEqual(
    listed.pulls.map((pull) => pull.number),
    [2],
  );
});
