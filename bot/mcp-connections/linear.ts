import { defineConnection } from "@cursor/bdk/connections";

/**
 * Linear's hosted MCP, authenticated with a personal API key from the
 * fe-demo workspace. The header template is the shape in the connections
 * reference: the value is read when the client opens, not at import.
 * `optional` keeps a turn alive when LINEAR_TOKEN is unset.
 */
export default defineConnection({
  url: "https://mcp.linear.app/mcp",
  headers: { authorization: "Bearer ${LINEAR_TOKEN}" },
  advertiseTools: true,
  optional: true,
});
