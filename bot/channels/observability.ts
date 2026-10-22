import { defineChannel, GET, POST, sharedSecretAuth } from "@cursor/bdk/channels";
import { z } from "zod";
import { notePreviewSignal } from "../lib/deploy.js";
import { demo, INCIDENT_ID_PATTERN, incidentContinuation, prNumberFromPreviewEnv } from "../lib/demo.js";
import { getIncident, principalFromAuth, putIncident } from "../lib/incidents.js";
import { appendSnapshot } from "../lib/metrics.js";
import { formatAlertPrompt } from "../lib/prompts.js";
import { resetObservability } from "../lib/reset.js";
import { listShippedIds, listUnresolvedShipped } from "../lib/shipped.js";
import {
  handleProductionRecovery,
  needsTurnFallback,
  getRecoveryRecord,
  observabilityAlertDecision,
  observabilityAlertSchema,
} from "../lib/recovery.js";

const incidentId = z.string().regex(INCIDENT_ID_PATTERN);

const metricsBody = z.object({
  metric: z.string().min(1),
  env: z.string().min(1),
  value: z.number(),
  baseline: z.number().optional(),
  window: z.string().optional(),
  at: z.string().optional(),
  incidentId: incidentId.optional(),
});

/**
 * Shared-secret auth, not HMAC. Hosting returns 400 for X-BDK-Session-Key
 * when the admitting policy is hmacSignatureAuth or publicEndpoint
 * (Channels reference, hosted session keys). Callers send
 * `X-BDK-Session-Key: incident:<id>` plus this header. The handler still
 * passes the same continuation token so local `serve`, which ignores the
 * header, joins the same conversation.
 */
export default defineChannel({
  auth: [
    sharedSecretAuth({
      header: "X-Observability-Token",
      secret: demo.observabilitySecret,
    }),
  ],
  routes: [
    POST("/alert", {
      description:
        "Start or resume anomaly triage for one incidentId. A body with status recovered or resolved closes a shipped incident and does not start triage.",
      bodySchema: observabilityAlertSchema,
      handler: async (_request, route) => {
        const body = route.body;
        if (observabilityAlertDecision(body.status) === "recovery") {
          // Hosted admission awaits this handler, so the outcome is known here
          // and a failed close-out can still hand off to a model turn.
          const outcome = await handleProductionRecovery(route.host, body);
          if (needsTurnFallback(outcome)) {
            console.log(
              `[spike-detector] recovery ${body.incidentId} handing off to a model turn (${outcome.reason ?? "unknown"})`,
            );
            await route.send(formatRecoveryFallbackPrompt(body.incidentId, outcome), {
              continuationToken: incidentContinuation(body.incidentId),
              admission: "coalesce",
              title: `Incident ${body.incidentId}`,
            });
          }
          return new Response(null, { status: 202 });
        }
        const existing = await getIncident(route.host.kv, body.incidentId);
        if (existing?.sessionStarted === true) {
          return new Response(null, { status: 202 });
        }
        await putIncident(route.host.kv, {
          incidentId: body.incidentId,
          metric: body.metric,
          env: body.env,
          baseline: body.baseline,
          value: body.value,
          window: body.window,
          status: "received",
          sessionStarted: true,
          updatedAt: new Date().toISOString(),
          principal: principalFromAuth(route.auth),
        });
        route.waitUntil(
          route.send(formatAlertPrompt(body), {
            continuationToken: incidentContinuation(body.incidentId),
            admission: "coalesce",
            title: `Incident ${body.incidentId}`,
          }),
        );
        return new Response(null, { status: 202 });
      },
    }),
    POST("/metrics", {
      description: "Store a metric snapshot in host KV. Does not start a model turn.",
      bodySchema: metricsBody,
      handler: async (_request, route) => {
        const body = route.body;
        await appendSnapshot(route.host.kv, {
          metric: body.metric,
          env: body.env,
          value: body.value,
          at: body.at ?? new Date().toISOString(),
          ...(body.baseline === undefined ? {} : { baseline: body.baseline }),
          ...(body.window === undefined ? {} : { window: body.window }),
          ...(body.incidentId === undefined ? {} : { incidentId: body.incidentId }),
        });
        if (prNumberFromPreviewEnv(body.env) !== undefined) {
          await notePreviewSignal(route.host.kv, body.env, body.metric);
        }
        return new Response(null, { status: 202 });
      },
    }),
    GET("/shipped", {
      description: "List shipped incidents that have not resolved yet, plus the last recorded recovery outcome per shipped incident.",
      querySchema: z.object({}),
      handler: async (_request, route) => {
        const items = await listUnresolvedShipped(route.host.kv);
        const recoveries: Record<string, unknown> = {};
        for (const incidentId of await listShippedIds(route.host.kv)) {
          const record = await getRecoveryRecord(route.host.kv, incidentId);
          if (record !== undefined) {
            const { body: _body, ...rest } = record;
            recoveries[incidentId] = rest;
          }
        }
        return Response.json({ items, recoveries });
      },
    }),
    POST("/reset", {
      description:
        "Close every open incident and clear shipped records. Does not start a model turn, including when the caller sends X-BDK-Session-Key.",
      bodySchema: z.object({}),
      handler: async (_request, route) => {
        // Hosted custom routes are replayed after a 202. The session key
        // (for example admin:reset) only names that delivery's mailbox.
        // This handler never calls send, so the replay is a skip and does
        // not start triage.
        const result = await resetObservability(route.host);
        return Response.json(result);
      },
    }),
  ],
});

function formatRecoveryFallbackPrompt(
  incidentId: string,
  outcome: { reason?: string; message?: string },
): string {
  return [
    `Production recovered for incident ${incidentId}, but the automatic close-out did not finish (${outcome.reason ?? "unknown"}${outcome.message === undefined ? "" : `: ${outcome.message}`}).`,
    `Call finish_production_close with incidentId ${incidentId}. It posts the resolution once and marks the Linear issue done with a resolved comment.`,
    "Do not call close_incident for this. Do not post anything else.",
  ].join("\n");
}
