import { demo } from "./demo.js";
import type { IncidentRecord } from "./incidents.js";
import { changeLabel, formatNumber, percentChange, scrubPublicText, severityLabel } from "./public-text.js";
import type { TriageReport } from "./triage-report.js";

export type SlackBlock = Record<string, unknown>;

export type SlackPayload = {
  text: string;
  blocks: SlackBlock[];
};

function header(text: string): SlackBlock {
  return {
    type: "header",
    text: { type: "plain_text", text: text.slice(0, 150), emoji: true },
  };
}

function section(text: string): SlackBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: text.slice(0, 3000) },
  };
}

function fields(pairs: readonly (readonly [string, string])[]): SlackBlock {
  return {
    type: "section",
    fields: pairs.slice(0, 10).map(([label, value]) => ({
      type: "mrkdwn",
      text: `*${label}*\n${value}`.slice(0, 2000),
    })),
  };
}

function context(text: string): SlackBlock {
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: text.slice(0, 2000) }],
  };
}

export function alertPayload(incident: IncidentRecord): SlackPayload {
  const change = percentChange(incident.baseline, incident.value);
  const severity = severityLabel(change.direction, change.pct);
  const metric = incident.metric;
  const value = formatNumber(incident.value);
  const baseline = formatNumber(incident.baseline);
  const movement = changeLabel(incident.baseline, incident.value);
  const agent =
    incident.cloudAgentUrl === undefined
      ? "Triage agent investigating…"
      : `Triage agent investigating… <${incident.cloudAgentUrl}|Open the triage agent>`;
  const linear =
    incident.linearIssueUrl !== undefined
      ? `<${incident.linearIssueUrl}|${incident.linearIssueId ?? "Linear issue"}>`
      : incident.linearIssueId;
  const lines = [
    `:rotating_light: ${severity} · Checkout anomaly on ${incident.env}`,
    `${metric}: ${value} vs baseline ${baseline} (${movement}) over ${incident.window}.`,
    agent.replace(/<([^|>]+)\|([^>]+)>/g, "$2 ($1)"),
    `incident:${incident.incidentId}`,
    "No action needed.",
  ];
  const blocks: SlackBlock[] = [
    header(`:rotating_light: ${severity} · Checkout anomaly`),
    fields([
      ["Metric", `\`${metric}\``],
      ["Environment", incident.env],
      ["Value", value],
      ["Baseline", baseline],
      ["Change", movement],
      ["Window", incident.window],
    ]),
    section(agent),
  ];
  if (linear !== undefined) {
    blocks.push(context(`Linear ${linear} · incident:${incident.incidentId} · No action needed`));
  } else {
    blocks.push(context(`incident:${incident.incidentId} · No action needed`));
  }
  return { text: lines.join("\n"), blocks };
}

export function triagePayload(input: {
  incident: IncidentRecord;
  report: TriageReport;
  ownerId: string;
}): SlackPayload {
  const report = {
    ...input.report,
    rootCause: scrubPublicText(input.report.rootCause),
    commitMessage:
      input.report.commitMessage === undefined
        ? undefined
        : scrubPublicText(input.report.commitMessage),
    impact: input.report.impact === undefined ? undefined : scrubPublicText(input.report.impact),
  };
  const confidence = report.confidence ?? "unspecified";
  const mention = input.ownerId === "" ? "" : `<@${input.ownerId}> `;
  const callToAction = `${mention}React 👍 to approve the fix (or reply approve)`;
  const commit = commitLine(report);
  const where = whereLine(report);
  const plan =
    report.plan.length === 0
      ? undefined
      : `*Proposed fix*\n${report.plan.map((item) => `• ${scrubPublicText(item)}`).join("\n")}`;
  const blocks: SlackBlock[] = [
    header(`:mag: Triage result · ${confidence}`),
    section(`*Suspected root cause*\n${report.rootCause || "The triage agent did not name a cause."}`),
  ];
  if (commit !== undefined) {
    blocks.push(section(commit));
  }
  if (where !== undefined) {
    blocks.push(section(where));
  }
  if (report.impact !== undefined && report.impact !== "") {
    blocks.push(section(`*Impact*\n${report.impact}`));
  }
  if (plan !== undefined) {
    blocks.push(section(plan));
  }
  blocks.push(section(`*Confidence*\n${confidence}`));
  blocks.push({ type: "divider" });
  blocks.push(section(callToAction));
  blocks.push({
    type: "actions",
    block_id: "incident_approve",
    elements: [
      {
        type: "button",
        action_id: "approve_incident_fix",
        style: "primary",
        text: { type: "plain_text", text: "Approve fix", emoji: true },
        value: input.incident.incidentId,
      },
    ],
  });
  const text = [
    `:mag: Triage result for incident:${input.incident.incidentId} (${confidence}).`,
    report.rootCause,
    commit?.replace(/<([^|>]+)\|([^>]+)>/g, "$2 $1") ?? "",
    where ?? "",
    report.impact ?? "",
    plan?.replace(/\*/g, "") ?? "",
    callToAction,
  ]
    .filter((line) => line.trim() !== "")
    .join("\n");
  return { text, blocks };
}

export function triageErrorPayload(incident: IncidentRecord, detail: string): SlackPayload {
  const text = [
    `:warning: Triage stopped before it produced a fix plan.`,
    scrubPublicText(detail),
    incident.cloudAgentUrl === undefined ? "" : incident.cloudAgentUrl,
    `incident:${incident.incidentId}`,
  ]
    .filter((line) => line.trim() !== "")
    .join("\n");
  const blocks: SlackBlock[] = [
    header(":warning: Triage incomplete"),
    section(scrubPublicText(detail) || "The triage agent stopped before it wrote a report."),
  ];
  if (incident.cloudAgentUrl !== undefined) {
    blocks.push(section(`<${incident.cloudAgentUrl}|Open the triage agent>`));
  }
  blocks.push(context(`incident:${incident.incidentId}`));
  return { text, blocks };
}

export function fixInProgressText(incidentId: string): string {
  return `🛠️ Fix in progress · incident:${incidentId}`;
}

export function pullRequestPayload(url: string, prNumber: number | undefined): SlackPayload {
  const label = prNumber === undefined ? "pull request" : `#${prNumber}`;
  return {
    text: `Fix pull request opened: ${url}`,
    blocks: [section(`*Fix pull request* · <${url}|${label}>`)],
  };
}

/** One sentence for the ship-review card. Drops lines that name internal setup. */
export function shipReviewSummary(report: string | undefined): string {
  const line = scrubPublicText(report ?? "")
    .split("\n")
    .map((item) => item.replace(/^Root cause:\s*/i, "").trim())
    .find((item) => item !== "" && !item.startsWith("-") && !/^plan:$/i.test(item));
  if (line === undefined) {
    return "Checkout metrics are ready for a production decision.";
  }
  return line.length > 180 ? `${line.slice(0, 177)}…` : line;
}

export const SHIP_REVIEW_TEXT = "Fix is ready for review · React 🚀 to ship to production";

export const SHIPPING_TEXT = "🚀 Shipping to production…";

export function shipReviewPayload(input: {
  incidentId: string;
  ownerId: string;
  prUrl: string;
  prNumber: number | undefined;
  summary: string;
}): SlackPayload {
  const mention = input.ownerId === "" ? "" : `<@${input.ownerId}> `;
  const headline = `${mention}${SHIP_REVIEW_TEXT}`;
  const label = input.prNumber === undefined ? "pull request" : `#${input.prNumber}`;
  const summary = scrubPublicText(input.summary);
  const blocks: SlackBlock[] = [
    header(":rocket: Fix is ready for review"),
    section(headline),
    section(`*Pull request* · <${input.prUrl}|${label}>`),
    context(`${summary} · incident:${input.incidentId}`),
  ];
  const text = [SHIP_REVIEW_TEXT, mention.trim(), input.prUrl, summary, `incident:${input.incidentId}`]
    .filter((line) => line !== "")
    .join("\n");
  return { text, blocks };
}

export function shippingPayload(): SlackPayload {
  return {
    text: SHIPPING_TEXT,
    blocks: [section(SHIPPING_TEXT)],
  };
}

export function productionResolvedPayload(input: {
  incidentId: string;
  gmv: { before?: number; after: number; baseline: number };
  aov: { before?: number; after: number; baseline: number };
  prUrl?: string;
  prNumber?: number;
  linearIssueId?: string;
  linearIssueUrl?: string;
}): SlackPayload {
  const gmv = metricLine("GMV", input.gmv);
  const aov = metricLine("AOV", input.aov);
  const pr =
    input.prUrl === undefined
      ? "Pull request pending"
      : input.prNumber === undefined
        ? input.prUrl
        : `<${input.prUrl}|#${input.prNumber}>`;
  const linear =
    input.linearIssueUrl !== undefined
      ? `<${input.linearIssueUrl}|${input.linearIssueId ?? "Linear issue"}>`
      : (input.linearIssueId ?? "No Linear issue");
  const plainPr =
    input.prUrl === undefined
      ? "Pull request pending"
      : input.prNumber === undefined
        ? input.prUrl
        : `#${input.prNumber} ${input.prUrl}`;
  const plainLinear = input.linearIssueId ?? "No Linear issue";
  const text = [
    `:white_check_mark: Resolved · incident:${input.incidentId}`,
    "GMV and average order value are back within 10% of baseline.",
    gmv.plain,
    aov.plain,
    `Pull request: ${plainPr}`,
    `Linear: ${plainLinear}`,
  ].join("\n");
  const blocks: SlackBlock[] = [
    header(":white_check_mark: Resolved"),
    section("GMV and average order value are back within 10% of baseline."),
    section(`${gmv.mrkdwn}\n\n${aov.mrkdwn}`),
    fields([
      ["Pull request", pr],
      ["Linear", linear],
    ]),
    context(`incident:${input.incidentId} · production`),
  ];
  return { text, blocks };
}

function metricLine(
  label: string,
  metric: { before?: number; after: number; baseline: number },
): { plain: string; mrkdwn: string } {
  const after = formatNumber(metric.after);
  const baseline = formatNumber(metric.baseline);
  const movement = changeLabel(metric.baseline, metric.after);
  const transition =
    metric.before === undefined ? after : `${formatNumber(metric.before)} → ${after}`;
  const plain = `${label}: ${transition} (${movement}, baseline ${baseline})`;
  const mrkdwn = `*${label}*\n${transition}\n${movement}, baseline ${baseline}`;
  return { plain, mrkdwn };
}

export function resolvedPayload(input: {
  incident: IncidentRecord;
  env: string;
  metrics: readonly { metric: string; value?: number; baseline?: number }[];
  note: string;
}): SlackPayload {
  const rows = input.metrics.map((metric) => {
    const after = metric.value === undefined ? "—" : formatNumber(metric.value);
    const baseline = metric.baseline === undefined ? "—" : formatNumber(metric.baseline);
    const before =
      metric.metric === input.incident.metric ? formatNumber(input.incident.value) : undefined;
    const body =
      before === undefined
        ? `${after} (baseline ${baseline})`
        : `${before} → ${after} (baseline ${baseline})`;
    return `*${metric.metric}*\n${body}`;
  });
  const note = scrubPublicText(input.note);
  const text = [
    `:white_check_mark: Incident resolved · incident:${input.incident.incidentId}`,
    `Recovered on ${input.env}.`,
    ...input.metrics.map((metric) => {
      const before =
        metric.metric === input.incident.metric ? formatNumber(input.incident.value) : "n/a";
      const after = metric.value === undefined ? "n/a" : formatNumber(metric.value);
      return `${metric.metric}: ${before} → ${after}`;
    }),
    note,
  ]
    .filter((line) => line.trim() !== "")
    .join("\n");
  const blocks: SlackBlock[] = [
    header(":white_check_mark: Incident resolved"),
    section(rows.join("\n\n") || "Metrics recovered."),
    context(`incident:${input.incident.incidentId} · ${input.env}`),
  ];
  if (note !== "") {
    blocks.push(section(note));
  }
  return { text, blocks };
}

function commitLine(report: TriageReport): string | undefined {
  if (report.commitSha === undefined) {
    return undefined;
  }
  const short = report.commitSha.slice(0, 7);
  const url = `${demo.repoUrl}/commit/${report.commitSha}`;
  const message =
    report.commitMessage !== undefined && report.commitMessage !== ""
      ? ` — ${report.commitMessage}`
      : "";
  return `*Suspect commit*\n<${url}|${short}>${message}`;
}

function whereLine(report: TriageReport): string | undefined {
  if (report.file === undefined && report.functionName === undefined) {
    return undefined;
  }
  const file = report.file === undefined ? "unknown file" : `\`${report.file}\``;
  const fn = report.functionName === undefined ? "" : ` · \`${report.functionName}\``;
  return `*Where*\n${file}${fn}`;
}
