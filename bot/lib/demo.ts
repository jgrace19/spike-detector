/**
 * Demo targets. The cloud agent starts from `demo/base`, and fix pull
 * requests target that same ref. Change `defaultStartingRef` here, or set
 * BUDGETSPHERE_STARTING_REF before a launch. On Cursor hosting, non-secret
 * env vars are not documented as injected; the named secret is read inside
 * {@link budgetsphereRepo} at launch time, not when this module loads.
 */
export const demo = {
  owner: "internalsphere",
  repo: "jg-budgetsphere",
  repoUrl: "https://github.com/internalsphere/jg-budgetsphere",
  defaultStartingRef: "demo/base",
  linearWorkspace: "fe-demo",
  linearProject: "Budgetsphere",
  observabilitySecret: "OBSERVABILITY_SHARED_SECRET",
  slackChannelEnv: "SPIKE_DETECTOR_SLACK_CHANNEL",
  codeOwnerEnv: "SPIKE_DETECTOR_CODE_OWNER_SLACK_ID",
  startingRefEnv: "BUDGETSPHERE_STARTING_REF",
  /** Preview metric env posted by the mock app: `preview-<pr number>`. */
  previewEnvPrefix: "preview-",
  /** |value - baseline| / max(|baseline|, 1) at or under this counts as recovered. */
  recoveryTolerance: 0.1,
  /** Rubric magnitude band when a change states a target number. */
  explainedTargetTolerance: 0.15,
  lookbackMs: 24 * 60 * 60 * 1000,
} as const;

export const INCIDENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export function incidentContinuation(incidentId: string): string {
  return `incident:${incidentId}`;
}

export function previewEnv(prNumber: number): string {
  return `${demo.previewEnvPrefix}${prNumber}`;
}

/** Called on each cloud-agent launch, when hosted secrets exist. */
export function budgetsphereRepo(): { url: string; startingRef: string } {
  const fromEnv = process.env[demo.startingRefEnv]?.trim();
  return {
    url: demo.repoUrl,
    startingRef: fromEnv && fromEnv.length > 0 ? fromEnv : demo.defaultStartingRef,
  };
}

export function slackChannelTarget(): string {
  return process.env[demo.slackChannelEnv]?.trim() ?? "";
}

export function codeOwnerSlackId(): string {
  return process.env[demo.codeOwnerEnv]?.trim() ?? "";
}
