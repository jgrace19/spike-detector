export function triageStopReady(status: string): boolean {
  return status === "finished" || status === "error" || status === "expired";
}

/**
 * The fix follow-up starts from a finished triage run. A poll that still
 * sees that finished status, with the same pull request URL, is not the
 * fix stop.
 */
export function fixStopReady(input: {
  status: string;
  prUrl?: string;
  baselinePrUrl: string;
  seenRunning: boolean;
}): boolean {
  if (input.status === "running" || input.status === "creating") {
    return false;
  }
  if (!triageStopReady(input.status)) {
    return false;
  }
  if (input.prUrl !== undefined && input.prUrl !== "" && input.prUrl !== input.baselinePrUrl) {
    return true;
  }
  return input.seenRunning;
}
