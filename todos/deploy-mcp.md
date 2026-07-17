# Deploy Copper MCP as a remote server on Cloud Run (Claude + ChatGPT integration)

## Goal

Take the existing stdio MCP server (`server.js`) and turn it into a **remote MCP
server** reachable over HTTPS, deployed to **Google Cloud Run** (project
`linnify-tech`), so it can be added as a **custom connector in the Claude web app**
and as a **custom MCP connector in the ChatGPT web app (Developer Mode)**.

All 8 existing tools stay exactly as they are. Only the transport layer changes.

---

## Background: what the research found

MCP is **transport-agnostic**. stdio (what we have) is one transport; the other
official one is **Streamable HTTP** — a single HTTP endpoint that both Claude and
ChatGPT speak. Both web apps connect to remote MCP servers over HTTPS; neither can
launch a local stdio process. So the server must expose an HTTP endpoint.

### Claude web app (custom connector) requirements
- **Transport:** Streamable HTTP (preferred). Legacy HTTP+SSE is deprecated — do NOT build on SSE.
- **Endpoint:** one public **HTTPS** URL, e.g. `https://<service>-<hash>.<region>.run.app/mcp`,
  handling `POST`, `GET`, and `DELETE` on that path.
- **Auth:** OAuth 2.1 (DCR) is supported but **not required**. A server with **no auth**
  can be added by URL — fine for our internal use. (If the server never returns a
  401 with OAuth discovery metadata, Claude just connects directly.)
- **How to add:** Claude web → **Settings → Connectors → Add custom connector** → paste the `/mcp` URL.
- **Limits to respect:** tool result max ~150,000 chars; request timeout 300s.

### ChatGPT web app (custom MCP connector) requirements
- **Requires Developer Mode**, available on Plus / Pro / Team / Enterprise / Edu plans.
  Enable at: Workspace/Settings → **Connectors / Developer mode** (Enterprise: admin must
  allow it under Permissions & Roles → Connected Data → Developer mode).
- **Transport:** Streamable HTTP works in Developer Mode. (The `/sse/` convention and the
  mandatory `search`+`fetch` tools only apply to the *non-developer* "deep research /
  company knowledge" connectors. In **Developer Mode arbitrary tools are allowed**, so our
  Copper tools work as-is — we do NOT need to implement `search`/`fetch`.)
- **Auth:** no-auth, API key, or OAuth all supported. No-auth is fine for internal use.
- **How to add:** ChatGPT → Settings → Connectors → **Create / Add custom connector** →
  paste the same `/mcp` URL. Write actions require per-call confirmation by default.

### Net conclusion
One Streamable-HTTP server, no auth, one public Cloud Run HTTPS URL → works for **both**
Claude and ChatGPT. No per-platform code branching needed.

---

## Implementation steps

### 1. Convert `server.js` transport from stdio → Streamable HTTP (Express)

Keep every `server.tool(...)` definition and all the Copper logic untouched. Replace
**only** the imports at the top and the `main()` block at the bottom.

- Remove: `import { StdioServerTransport } from ".../server/stdio.js";`
- Add:
  ```js
  import express from "express";
  import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
  ```
- Replace the `main()` / stdio wiring with an Express app. Use **stateless mode**
  (`sessionIdGenerator: undefined`) — it's the simplest and plays nicest with Cloud Run
  autoscaling (any instance can serve any request; no sticky sessions needed). Our tools
  are request/response only, so we don't need server-initiated streaming/sessions.

  ```js
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    // Stateless: a fresh transport per request, no session state to share across instances.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Stateless mode has no sessions, so GET (SSE stream) and DELETE (teardown) aren't used.
  // Return 405 so clients get a clean answer instead of a hang.
  const methodNotAllowed = (_req, res) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // Health check for Cloud Run
  app.get("/healthz", (_req, res) => res.status(200).send("ok"));

  const port = process.env.PORT || 8080;
  app.listen(port, () => console.error(`Copper MCP listening on :${port}`));
  ```

- **Note:** the SDK's `McpServer` may be single-use per transport. If reusing the one
  top-level `server` across requests throws (already-connected error), instead build the
  server inside a small factory called per request. Verify with the MCP Inspector (step 6).
  If a factory is needed, wrap the existing `new McpServer(...)` + all `server.tool(...)`
  calls in a `function buildServer() { ... return server; }` and call it inside the handler.
- **Important:** the server currently `console.error`s and `process.exit(1)` if the
  `COPPER_*` env vars are missing. Keep that — but make sure Cloud Run has them set
  (step 4) or the container will crash-loop on startup and fail the deploy.
- **Listen on `0.0.0.0:$PORT`** (Express default host is fine; just use `process.env.PORT`).

### 2. Add `express` to `package.json`

- Add `"express": "^5.2.1"` to `dependencies` (it's already in `node_modules`, but must be
  declared so `npm ci` in the Docker build installs it).
- Run `npm install` locally to update `package-lock.json`, then commit the lockfile.

### 3. Add a `Dockerfile` (repo root)

```dockerfile
FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
# PORT is provided by Cloud Run (defaults to 8080); server reads process.env.PORT
CMD ["node", "server.js"]
```

### 4. Add a `.gcloudignore` (repo root)

Avoid uploading junk to the build:
```
.git
node_modules
.env
*.md
todos/
```
(`node_modules` is excluded so `npm ci` rebuilds cleanly in the image.)

### 5. Deploy to Cloud Run (project `linnify-tech`)

Env vars are passed **plain** (approved — internal-only use for now).

```bash
gcloud config set project linnify-tech

gcloud run deploy copper-mcp \
  --source . \
  --region europe-west1 \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances 1 \
  --set-env-vars "COPPER_API_KEY=<key>,COPPER_USER_EMAIL=<email>,COPPER_USER_ID=<id>"
```

Notes:
- `--allow-unauthenticated` is **required** — Claude/ChatGPT cannot pass Google IAM
  credentials, so the endpoint must be publicly reachable. See the security note below.
- `--min-instances 1` avoids cold starts (optional; drop to 0 to save cost if latency is OK).
- Because we use **stateless** transport, autoscaling to multiple instances is safe. If we
  ever switch to session-based mode, we'd need `--session-affinity` and `--max-instances 1`.
- Cloud Run gives HTTPS automatically. The connector URL is: `https://<service-url>/mcp`.

### 6. Verify before wiring up the web apps
- Locally: `COPPER_API_KEY=... COPPER_USER_EMAIL=... COPPER_USER_ID=... PORT=8080 node server.js`,
  then run the **MCP Inspector** (`npx @modelcontextprotocol/inspector`) against
  `http://localhost:8080/mcp` (Streamable HTTP). Confirm `initialize` succeeds and all 8
  tools list + a read tool (e.g. `list_activity_types`) returns data.
- After deploy: repeat against the Cloud Run `https://.../mcp` URL.

### 7. Add the connector in each web app
- **Claude:** Settings → Connectors → Add custom connector → paste `https://.../mcp`.
- **ChatGPT:** enable Developer Mode → Connectors → create custom connector → paste the same URL.

---

## Security / caveats to flag (decided acceptable for now, but note them)

- **The endpoint is public and unauthenticated.** Anyone who learns the `*.run.app` URL can
  call every tool — including the **write** tools (`create_person`, `update_person`,
  `create_activity`) — acting as our single Copper API user. The URL is unguessable but not
  secret. **Recommended follow-up** (not blocking): add a simple bearer-token check in the
  Express handler (reject requests without a shared `Authorization` header), and/or put Cloud
  Run behind a load balancer + IAP. Both Claude and ChatGPT let you attach custom headers /
  API-key auth to a connector, so a static bearer token is cheap to add later.
- Copper credentials live as plain Cloud Run env vars (approved). To harden later, move
  `COPPER_API_KEY` to **Secret Manager** and use `--set-secrets` instead of `--set-env-vars`.
- Respect the ~150k-char Claude tool-result cap — `list_activities` with `page_size` up to 200
  plus name resolution could get large; fine for now, watch it.

## Definition of done
- `server.js` serves Streamable HTTP on `/mcp` (stdio removed), `express` declared in `package.json`.
- `Dockerfile` + `.gcloudignore` committed; lockfile updated.
- Service deployed to Cloud Run in `linnify-tech`, reachable at `https://.../mcp`.
- MCP Inspector lists all 8 tools against the deployed URL.
- Connector added and a tool call succeeds from **both** Claude web and ChatGPT web.
