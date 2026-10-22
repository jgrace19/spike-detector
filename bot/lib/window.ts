import { demo } from "./demo.js";

const WINDOW_PATTERN = /^(\d+)(m|h|d)$/;

export function parseWindowMs(window: string): number | undefined {
  const match = WINDOW_PATTERN.exec(window.trim());
  if (match === null) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "m") {
    return amount * 60 * 1000;
  }
  if (unit === "h") {
    return amount * 60 * 60 * 1000;
  }
  return amount * 24 * 60 * 60 * 1000;
}

export function searchBounds(window: string, nowMs = Date.now()): {
  since: string;
  alertSince: string;
} {
  const alertMs = parseWindowMs(window) ?? demo.lookbackMs;
  const searchMs = Math.max(alertMs, demo.lookbackMs);
  return {
    since: new Date(nowMs - searchMs).toISOString(),
    alertSince: new Date(nowMs - alertMs).toISOString(),
  };
}
