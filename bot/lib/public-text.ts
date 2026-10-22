import { INCIDENT_ID_PATTERN } from "./demo.js";

const LEAK =
  /\b(demo\/base|demo branch|mock metrics(?: platform)?|MARKETPLACE_STARTING_REF|startingRef|demo setup|not in prod|only on a demo)\b/i;

const INCIDENT_IN_TEXT = /incident:([A-Za-z0-9][A-Za-z0-9._:-]{0,119})/;

const STOP_WAKE = /^\[cloud agent stopped\]\s+(\S+)\s+is\s+(finished|error|expired)\./;

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

export function percentChange(
  baseline: number,
  value: number,
): { pct: number; direction: "drop" | "rise" | "flat" } {
  const scale = Math.max(Math.abs(baseline), 1);
  const pct = Math.round((Math.abs(value - baseline) / scale) * 100);
  if (pct === 0) {
    return { pct: 0, direction: "flat" };
  }
  return { pct, direction: value < baseline ? "drop" : "rise" };
}

export function severityLabel(direction: "drop" | "rise" | "flat", pct: number): string {
  if (direction === "drop" && pct >= 50) {
    return "SEV-1";
  }
  if (direction === "drop" && pct >= 25) {
    return "SEV-2";
  }
  if (pct >= 10) {
    return "SEV-3";
  }
  return "SEV-4";
}

export function changeLabel(baseline: number, value: number): string {
  const change = percentChange(baseline, value);
  if (change.direction === "flat") {
    return "flat vs baseline";
  }
  return `${change.pct}% ${change.direction}`;
}

/** Drop lines that would leak demo setup into Slack or Linear. */
export function scrubPublicText(text: string): string {
  return text
    .split("\n")
    .filter((line) => !LEAK.test(line))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function incidentIdInText(text: string): string | undefined {
  const id = text.match(INCIDENT_IN_TEXT)?.[1];
  if (id === undefined || !INCIDENT_ID_PATTERN.test(id)) {
    return undefined;
  }
  return id;
}

export function slackTsMs(ts: string): number {
  const value = Number(ts);
  return Number.isFinite(value) ? value : 0;
}

/**
 * A sign-off reply is a short approval, not a question and not a sentence
 * that merely contains the word.
 */
export function isApprovalReply(text: string): boolean {
  const cleaned = text
    .replace(/<@[A-Z0-9]+>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "" || cleaned.includes("?") || cleaned.length > 120) {
    return false;
  }
  const match = /^(approve[d]?|lgtm|ship it|signed off)\b\s*(.*)$/i.exec(cleaned);
  if (match === null) {
    return false;
  }
  const rest = (match[2] ?? "").trim().replace(/[.!]$/, "").trim();
  if (rest === "" || /^the fix$/i.test(rest)) {
    return true;
  }
  return /^incident:[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(rest);
}

export function parseStopWake(text: string):
  | {
      agentId: string;
      status: "finished" | "error" | "expired";
      info: Record<string, unknown>;
    }
  | undefined {
  const first = text.split("\n")[0] ?? "";
  const match = STOP_WAKE.exec(first);
  if (match === null) {
    return undefined;
  }
  const status = match[2];
  if (status !== "finished" && status !== "error" && status !== "expired") {
    return undefined;
  }
  const newline = text.indexOf("\n");
  let info: Record<string, unknown> = {};
  if (newline >= 0) {
    try {
      const parsed: unknown = JSON.parse(text.slice(newline + 1));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        info = parsed as Record<string, unknown>;
      }
    } catch {
      info = {};
    }
  }
  return { agentId: match[1] ?? "", status, info };
}

export function prNumberFromUrl(url: string): number | undefined {
  const match = /\/pull\/(\d+)/.exec(url);
  if (match === null) {
    return undefined;
  }
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

export function extractPrUrl(text: string): string | undefined {
  const match = text.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/);
  return match?.[0];
}

export function incidentIdFromContinuation(token: string | null): string | undefined {
  if (token === null || !token.startsWith("incident:")) {
    return undefined;
  }
  const id = token.slice("incident:".length);
  return INCIDENT_ID_PATTERN.test(id) ? id : undefined;
}

export function stringField(info: Record<string, unknown>, key: string): string | undefined {
  const value = info[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
