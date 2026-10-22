import { scrubPublicText } from "./public-text.js";

export type TriageReport = {
  rootCause: string;
  commitSha?: string;
  commitMessage?: string;
  file?: string;
  functionName?: string;
  impact?: string;
  confidence?: string;
  plan: string[];
};

const FENCE = /```incident-report\s*([\s\S]*?)```/i;
const SHA = /\b([0-9a-f]{7,40})\b/i;

function field(body: string, name: string): string | undefined {
  const match = new RegExp(`^${name}:\\s*(.+)$`, "im").exec(body);
  const value = match?.[1]?.trim();
  if (value === undefined || value === "" || /^none$/i.test(value)) {
    return undefined;
  }
  return value;
}

function planLines(body: string): string[] {
  const start = body.search(/^plan:\s*$/im);
  if (start < 0) {
    return [];
  }
  const after = body.slice(start).split("\n").slice(1);
  const items: string[] = [];
  for (const line of after) {
    const item = /^[-*]\s+(.+)$/.exec(line.trim());
    if (item?.[1] !== undefined) {
      items.push(item[1].trim());
      continue;
    }
    if (line.trim() === "") {
      continue;
    }
    break;
  }
  return items;
}

export function parseTriageReport(text: string): TriageReport {
  const scrubbed = scrubPublicText(text);
  const fenced = FENCE.exec(scrubbed)?.[1] ?? scrubbed;
  const root = field(fenced, "root_cause") ?? firstSentence(scrubbed);
  const sha = normalizeSha(field(fenced, "commit_sha") ?? scrubbed.match(SHA)?.[1]);
  return {
    rootCause: root,
    commitSha: sha,
    commitMessage: field(fenced, "commit_message"),
    file: field(fenced, "file"),
    functionName: field(fenced, "function"),
    impact: field(fenced, "impact"),
    confidence: normalizeConfidence(field(fenced, "confidence")),
    plan: planLines(fenced).map((item) => scrubPublicText(item)).filter((item) => item !== ""),
  };
}

export function reportHasFindings(report: TriageReport): boolean {
  return report.rootCause.trim() !== "" || report.plan.length > 0;
}

export function reportAsPlan(report: TriageReport): string {
  const lines = [`Root cause: ${report.rootCause}`];
  if (report.commitSha !== undefined) {
    lines.push(`Commit: ${report.commitSha}${report.commitMessage ? ` ${report.commitMessage}` : ""}`);
  }
  if (report.file !== undefined) {
    lines.push(`File: ${report.file}`);
  }
  if (report.functionName !== undefined) {
    lines.push(`Function: ${report.functionName}`);
  }
  if (report.impact !== undefined) {
    lines.push(`Impact: ${report.impact}`);
  }
  if (report.plan.length > 0) {
    lines.push("Plan:", ...report.plan.map((item) => `- ${item}`));
  }
  return scrubPublicText(lines.join("\n"));
}

function firstSentence(text: string): string {
  const withoutFence = text.replace(FENCE, "").trim();
  const line = withoutFence
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item !== "" && !item.startsWith("```"));
  if (line === undefined) {
    return "";
  }
  return line.replace(/^root_cause:\s*/i, "").slice(0, 500);
}

function normalizeSha(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = SHA.exec(value);
  return match?.[1];
}

function normalizeConfidence(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const word = value.toLowerCase();
  if (word.startsWith("high")) {
    return "high";
  }
  if (word.startsWith("medium") || word.startsWith("med")) {
    return "medium";
  }
  if (word.startsWith("low")) {
    return "low";
  }
  return undefined;
}
