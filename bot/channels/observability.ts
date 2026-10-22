import { defineChannel, POST, sharedSecretAuth } from "@cursor/bdk/channels";
import { z } from "zod";
import { notePreviewSignal } from "../lib/deploy.js";
import { demo, INCIDENT_ID_PATTERN, incidentContinuation, prNumberFromPreviewEnv } from "../lib/demo.js";
import { getIncident, principalFromAuth, putIncident } from "../lib/incidents.js";
import { appendSnapshot } from "../lib/metrics.js";
import { formatAlertPrompt } from "../lib/prompts.js";

const incidentId = z.string().regex(INCIDENT_ID_PATTERN);

const alertBody = z.object({
  incidentId,
  metric: z.string().min(1),
  env: z.string().min(1),
  baseline: z.number(),
  value: z.number(),
  window: z.string().min(1),
});

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
      description: "Start or resume anomaly triage for one incidentId.",
      bodySchema: alertBody,
      handler: async (_request, route) => {
        const body = route.body;
        const existing = await getIncident(route.host.kv, body.incidentId);
        if (existing?.sessionStarted === true) {
          return new Response(null, { status: 202 });
        }
        await putIncident(route.host.kv, {
          ...body,
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
