import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAll } from "./register.js";

// Read vs. action classification derived from the tool-name prefix (the naming convention IS the
// source of truth): get_/search_/list_ are read-only; create_/update_/delete_/bulk_/upsert_/convert_
// mutate data. Exposed as MCP tool annotations so clients (e.g. Claude) can auto-allow reads and
// gate actions behind approval.
function annotationsFor(name) {
  if (/^(get_|search_|list_)/.test(name)) return { readOnlyHint: true, openWorldHint: true };
  const ann = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  if (name.startsWith("delete_")) ann.destructiveHint = true;
  if (/^(update_|delete_|upsert_)/.test(name)) ann.idempotentHint = true;
  return ann;
}

// Factory: a configured McpServer with every registered tool. The transport (stdio locally,
// Streamable HTTP on Cloud Run) is chosen by the caller (server.js) — this stays transport-agnostic.
export function buildServer() {
  const server = new McpServer({ name: "copper-crm", version: "1.0.0" });

  // Wrap server.tool so every module's `server.tool(name, description, shape, cb)` call gets the
  // right read/action annotations automatically — no per-tool edits. Uses the unambiguous
  // registerTool({ inputSchema, annotations }) config form under the hood.
  const registerTool = server.registerTool.bind(server);
  server.tool = (name, description, inputSchema, cb) =>
    registerTool(name, { description, inputSchema: inputSchema ?? {}, annotations: annotationsFor(name) }, cb);

  registerAll(server);
  return server;
}
