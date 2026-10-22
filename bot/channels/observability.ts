import { defineChannel, POST, sharedSecretAuth } from "@cursor/bdk/channels";
import { z } from "zod";
import { notePreviewSignal } from "../lib/deploy.js";
import { demo, INCIDENT_ID_PATTERN, incidentContinuation, prNumberFromPreviewEnv } from "../lib/demo.js";
import { getIncident, principalFromAuth, putIncident } from "../lib/incidents.js";
import { appendSnapshot } from "../lib/metrics.js";
import { formatAlertPrompt } from "../lib/prompts.js";
import {
  handleProductionRecovery,
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
          route.waitUntil(
            handleProductionRecovery(route.host, body).catch((error: unknown) => {
              console.warn(
                `[spike-detector] production recovery failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }),
          );
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
  ],
});
