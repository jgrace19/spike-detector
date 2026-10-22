import { defineConnection } from "@cursor/bdk/connections";

/**
 * Linear via the signed-in Cursor account. `optional` so a local eval still
 * boots before the connector is attached.
 *
 * TODO: the official triage template also lists the connector name
 * "Linear MCP". This file follows the requested `servers: ["Linear"]`.
 * If create/update calls return not_connected against the fe-demo
 * workspace, add "Linear MCP" here.
 */
export default defineConnection({
  cursorAccount: true,
  servers: ["Linear"],
  advertiseTools: true,
  optional: true,
});
