import { demo } from "./demo.js";

/** Optional. Read inside the ship call, not at module load. */
export const DEPLOY_HOOK_URL_ENV = "DEPLOY_HOOK_URL";

export const DEPLOY_HOOK_TIMEOUT_MS = 10_000;

/** Extra attempts after the first POST. */
export const DEPLOY_HOOK_RETRIES = 2;

export type DeployHookBody = {
  incidentId: string;
  prNumber: number;
  branch: string;
  headSha: string;
};

export type DeployHookResult =
  | { status: "skipped" }
  | { status: "sent" }
  | { status: "failed"; reason: string };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Tell the production deploy pipeline a ship was recorded.
 * No-op when DEPLOY_HOOK_URL is unset. Secret values are read here so a
 * later update is visible on the next call.
 */
export async function notifyDeployHook(
  body: DeployHookBody,
  fetchImpl: FetchLike = fetch,
): Promise<DeployHookResult> {
  const base = process.env[DEPLOY_HOOK_URL_ENV]?.trim() ?? "";
  if (base === "") {
    return { status: "skipped" };
  }
  const token = process.env[demo.observabilitySecret]?.trim() ?? "";
  const url = `${base.replace(/\/$/, "")}/api/ship-hook`;
  const payload = JSON.stringify({
    incidentId: body.incidentId,
    prNumber: body.prNumber,
    branch: body.branch,
    headSha: body.headSha,
  });
  let reason = "deploy hook failed";
  const attempts = DEPLOY_HOOK_RETRIES + 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Observability-Token": token,
        },
        body: payload,
        signal: AbortSignal.timeout(DEPLOY_HOOK_TIMEOUT_MS),
      });
      if (response.ok) {
        return { status: "sent" };
      }
      await response.body?.cancel();
      reason = `status ${response.status}`;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  return { status: "failed", reason };
}
