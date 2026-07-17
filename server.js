import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { buildServer } from "./src/buildServer.js";
import {
  authEnabled,
  requireAuth,
  corsMiddleware,
  protectedResourceMetadata,
  authorizationServerMetadata,
  authorize,
  token,
} from "./src/oauth.js";

// Tools + Copper API layer live in src/ (see src/register.js). This file is only the transport:
// Streamable HTTP over Express, stateless mode (a fresh McpServer + transport per request), so any
// Cloud Run instance can serve any request with no shared session state. OAuth (src/oauth.js)
// guards /mcp when its env vars (OAUTH_CLIENT_ID/SECRET/JWT_SECRET) are set — see README.

// --- Start (Streamable HTTP over Express) ---
const app = express();
app.use(corsMiddleware);
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true })); // OAuth /token posts form-encoded bodies

// --- OAuth 2.1 endpoints (discovery + authorize + token) — public: they ARE the auth ---
app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);
app.get("/.well-known/oauth-authorization-server", authorizationServerMetadata);
app.get("/.well-known/oauth-authorization-server/mcp", authorizationServerMetadata);
app.get("/authorize", authorize);
app.post("/token", token);

// Single MCP endpoint. Stateless mode: new server + transport per request. requireAuth enforces the
// Bearer token when OAuth env vars are set (no-op otherwise, so local dev stays open).
app.post("/mcp", requireAuth, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode has no sessions, so the SSE stream (GET) and teardown (DELETE)
// are unused. Respond cleanly instead of leaving clients hanging.
function methodNotAllowed(_req, res) {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
}
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// Health check for Cloud Run.
// NOTE: use /health, NOT /healthz — Google Front End reserves /healthz and
// intercepts it before it reaches the container (returns a Google 404).
app.get("/health", (_req, res) => res.status(200).send("ok"));

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.error(`Copper MCP (Streamable HTTP) listening on :${port} — OAuth ${authEnabled ? "ENABLED" : "DISABLED (open — set OAUTH_* to enable)"}`);
});
