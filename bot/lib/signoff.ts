import type { HostContext } from "@cursor/bdk";
import { incidentContinuation } from "./demo.js";
import { getIncident, updateIncident } from "./incidents.js";
import { addReaction, postSlack } from "./notify.js";
import { signoffWakePrompt } from "./prompts.js";
import { serialize } from "./serialize.js";
import { fixInProgressText } from "./slack-cards.js";

export type SignoffResult =
  | { status: "recorded"; wake: "sent" | "reminder" }
  | { status: "already" }
  | { status: "rejected"; reason: string };

/**
 * First valid sign-off records the note, posts one fix-in-progress line,
 * and wakes the incident session once. Later calls do not post text.
 */
export async function applySignoff(input: {
  host: HostContext;
  incidentId: string;
  note: string;
  wake?: (incidentId: string) => Promise<void>;
}): Promise<SignoffResult> {
  return serialize(`signoff:${input.incidentId}`, () => applySignoffLocked(input));
}

async function applySignoffLocked(input: {
  host: HostContext;
  incidentId: string;
  note: string;
  wake?: (incidentId: string) => Promise<void>;
}): Promise<SignoffResult> {
  const incident = await getIncident(input.host.kv, input.incidentId);
  if (incident === undefined) {
    return { status: "rejected", reason: "unknown_incident" };
  }
  if (incident.status !== "bug") {
    return { status: "rejected", reason: "not_a_bug" };
  }
  if (incident.triageSlackTs === undefined) {
    return { status: "rejected", reason: "triage_not_posted" };
  }
  if (incident.signedOffAt !== undefined) {
    return { status: "already" };
  }
  const signedOffAt = new Date().toISOString();
  await updateIncident(input.host.kv, input.incidentId, {
    signedOffAt,
    signedOffNote: input.note,
    signoffWakeSent: false,
  });
  if (incident.fixProgressPostedAt === undefined && incident.slackThreadTs !== undefined) {
    const posted = await postSlack({
      host: input.host,
      incident: { ...incident, signedOffAt, signedOffNote: input.note },
      text: fixInProgressText(input.incidentId),
      thread: true,
    });
    if (posted.posted) {
      await updateIncident(input.host.kv, input.incidentId, {
        fixProgressPostedAt: new Date().toISOString(),
      });
    }
  }
  try {
    if (input.wake !== undefined) {
      await input.wake(input.incidentId);
    } else {
      await queueSignoffWake(input.host, input.incidentId);
    }
    await updateIncident(input.host.kv, input.incidentId, { signoffWakeSent: true });
    return { status: "recorded", wake: "sent" };
  } catch {
    return { status: "recorded", wake: "reminder" };
  }
}

export async function queueSignoffWake(host: HostContext, incidentId: string): Promise<void> {
  if (host.reminders === undefined) {
    throw new Error("reminders_unavailable");
  }
  const purpose = `signoff-now:${incidentId}`;
  const existing = await host.reminders.list({ purpose, status: "armed" });
  if (existing.length > 0) {
    return;
  }
  await host.reminders.create({
    purpose,
    channelId: "observability",
    continuationToken: incidentContinuation(incidentId),
    delay: "1s",
    prompt: signoffWakePrompt(incidentId),
    busyPolicy: "queueBehindTurn",
  });
}

export async function ackSignoff(input: {
  host: HostContext;
  channel: string;
  ts: string;
}): Promise<void> {
  await addReaction({ ...input, name: "eyes" });
}
