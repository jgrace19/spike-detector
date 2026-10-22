import { readFile } from "node:fs/promises";
import type { HostGitHubClient } from "@cursor/bdk";
import { demo, marketplaceRepo } from "./demo.js";
import { isRecord } from "./json.js";
import { searchBounds } from "./window.js";

export type ChangeCommit = {
  sha: string;
  message: string;
  url: string;
  date: string;
  inAlertWindow: boolean;
};

export type ChangePull = {
  number: number;
  title: string;
  body: string;
  url: string;
  updatedAt: string;
  merged: boolean;
  inAlertWindow: boolean;
};

export type ChangeList = {
  ok: true;
  source: "github" | "eval-fixture";
  repo: string;
  /** Branch that production serves. Every commit here is deployed to env prod. */
  productionRef: string;
  since: string;
  alertSince: string;
  commits: ChangeCommit[];
  pulls: ChangePull[];
};

const FIXTURE_URL = new URL("../../fixtures/changes.json", import.meta.url);

export async function listChanges(input: {
  incidentId: string;
  window: string;
  purpose: "live" | "eval" | undefined;
  github: HostGitHubClient;
}): Promise<ChangeList | { ok: false; error: string }> {
  const bounds = searchBounds(input.window);
  if (input.purpose === "eval") {
    return fixtureChanges(input.incidentId, bounds);
  }
  try {
    const octokit = await input.github.getOctokit();
    const productionRef = marketplaceRepo().startingRef;
    const [commitResponse, pullResponse] = await Promise.all([
      octokit.rest.repos.listCommits({
        owner: demo.owner,
        repo: demo.repo,
        sha: productionRef,
        since: bounds.since,
        per_page: 15,
      }),
      octokit.rest.pulls.list({
        owner: demo.owner,
        repo: demo.repo,
        base: productionRef,
        state: "all",
        sort: "updated",
        direction: "desc",
        per_page: 15,
      }),
    ]);
    const alertSince = Date.parse(bounds.alertSince);
    const commits: ChangeCommit[] = commitResponse.data.map((commit) => {
      const date = commit.commit.author?.date ?? commit.commit.committer?.date ?? "";
      return {
        sha: commit.sha,
        message: firstLine(commit.commit.message),
        url: commit.html_url,
        date,
        inAlertWindow: date !== "" && Date.parse(date) >= alertSince,
      };
    });
    const sinceMs = Date.parse(bounds.since);
    const pulls: ChangePull[] = pullResponse.data.flatMap((pull) => {
      const updatedAt = pull.updated_at;
      if (Date.parse(updatedAt) < sinceMs) {
        return [];
      }
      return [
        {
          number: pull.number,
          title: pull.title,
          body: (pull.body ?? "").slice(0, 800),
          url: pull.html_url,
          updatedAt,
          merged: pull.merged_at !== null,
          inAlertWindow: Date.parse(updatedAt) >= alertSince,
        },
      ];
    });
    return {
      ok: true,
      source: "github",
      repo: `${demo.owner}/${demo.repo}`,
      productionRef,
      since: bounds.since,
      alertSince: bounds.alertSince,
      commits,
      pulls,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

async function fixtureChanges(
  incidentId: string,
  bounds: { since: string; alertSince: string },
): Promise<ChangeList> {
  const parsed: unknown = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
  const entry = isRecord(parsed) ? parsed[incidentId] : undefined;
  const commits = isRecord(entry) && Array.isArray(entry.commits) ? entry.commits : [];
  const pulls = isRecord(entry) && Array.isArray(entry.pulls) ? entry.pulls : [];
  return {
    ok: true,
    source: "eval-fixture",
    repo: `${demo.owner}/${demo.repo}`,
    productionRef: marketplaceRepo().startingRef,
    since: bounds.since,
    alertSince: bounds.alertSince,
    commits: commits.filter(isCommit).map((commit) => ({ ...commit, inAlertWindow: true })),
    pulls: pulls.filter(isPull).map((pull) => ({ ...pull, inAlertWindow: true })),
  };
}

function firstLine(message: string): string {
  return message.split("\n")[0]?.slice(0, 300) ?? "";
}

function isCommit(value: unknown): value is ChangeCommit {
  return (
    isRecord(value) &&
    typeof value.sha === "string" &&
    typeof value.message === "string" &&
    typeof value.url === "string" &&
    typeof value.date === "string"
  );
}

function isPull(value: unknown): value is ChangePull {
  return (
    isRecord(value) &&
    typeof value.number === "number" &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    typeof value.url === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.merged === "boolean"
  );
}
