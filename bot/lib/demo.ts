/**
 * Marketplace demo targets. Cloud agents start from `demo/base`, and fix
 * pull requests target that same ref. Set MARKETPLACE_STARTING_REF to
 * override it. On Cursor hosting that name is a deployment secret, read
 * inside {@link marketplaceRepo} at launch time.
 *
 * Linear stays in the fe-demo workspace. LINEAR_PROJECT overrides the
 * project name and is read when an issue is opened.
 */
export const demo = {
  owner: "jgrace19",
  repo: "marketplace",
  repoUrl: "https://github.com/jgrace19/marketplace",
  defaultStartingRef: "demo/base",
  linearWorkspace: "fe-demo",
  defaultLinearProject: "Marketplace",
  observabilitySecret: "OBSERVABILITY_SHARED_SECRET",
  slackChannelEnv: "SPIKE_DETECTOR_SLACK_CHANNEL",
  codeOwnerEnv: "SPIKE_DETECTOR_CODE_OWNER_SLACK_ID",
  startingRefEnv: "MARKETPLACE_STARTING_REF",
  linearProjectEnv: "LINEAR_PROJECT",
  /** Metric env the mock app posts for a pull request: `preview-<pr number>`. */
  previewEnvPrefix: "preview-",
  /** |value - baseline| / max(|baseline|, 1) at or under this counts as recovered. */
  recoveryTolerance: 0.1,
  /** Rubric magnitude band when a change states a target number. */
  explainedTargetTolerance: 0.15,
  lookbackMs: 24 * 60 * 60 * 1000,
} as const;

/** Revenue metrics that must return to baseline before an incident closes. */
export const validationMetrics = [
  "freshcart.checkout.gmv_cents",
  "freshcart.checkout.average_order_value_cents",
] as const;

export const INCIDENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export function incidentContinuation(incidentId: string): string {
  return `incident:${incidentId}`;
}

export function previewEnv(prNumber: number): string {
  return `${demo.previewEnvPrefix}${prNumber}`;
}

export function prNumberFromPreviewEnv(env: string): number | undefined {
  const match = /^preview-(\d+)$/.exec(env);
  if (match === null) {
    return undefined;
  }
  return Number(match[1]);
}

/** Called on each cloud-agent launch, when hosted secrets exist. */
export function marketplaceRepo(): { url: string; startingRef: string } {
  const fromEnv = process.env[demo.startingRefEnv]?.trim();
  return {
    url: demo.repoUrl,
    startingRef: fromEnv && fromEnv.length > 0 ? fromEnv : demo.defaultStartingRef,
  };
}

/** Called when a Linear issue is created, when hosted secrets exist. */
export function linearProjectName(): string {
  const fromEnv = process.env[demo.linearProjectEnv]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : demo.defaultLinearProject;
}

export function slackChannelTarget(): string {
  return process.env[demo.slackChannelEnv]?.trim() ?? "";
}

export function codeOwnerSlackId(): string {
  return process.env[demo.codeOwnerEnv]?.trim() ?? "";
}
