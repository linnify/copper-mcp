# copper-mcp

MCP server for the [Copper CRM](https://www.copper.com/) API — search contacts, log activities, manage opportunities/projects/tasks, and query companies. Served over **Streamable HTTP** for deployment (Cloud Run → Claude Chat / ChatGPT connectors).

**56 tools** across 10 resources. Tools are added one resource module at a time and each is verified against a live Copper sandbox (HTTP 200) before being wired in.

## Tools

| Resource | Tools |
|----------|-------|
| **People** (9) | `search_people`, `get_person`, `get_person_by_email`, `create_person`, `bulk_create_people`, `update_person`, `bulk_update_people`, `delete_person`, `list_person_activities` |
| **Companies** (8) | `search_companies`, `get_company`, `create_company`, `bulk_create_companies`, `update_company`, `bulk_update_companies`, `delete_company`, `list_company_activities` |
| **Opportunities** (6) | `search_opportunities`, `get_opportunity`, `create_opportunity`, `bulk_create_opportunities`, `update_opportunity`, `delete_opportunity` |
| **Projects** (5) | `search_projects`, `get_project`, `create_project`, `update_project`, `delete_project` |
| **Tasks** (5) | `search_tasks`, `get_task`, `create_task`, `update_task`, `delete_task` |
| **Activities** (6) | `search_activities`, `get_activity`, `create_activity`, `bulk_create_activities`, `update_activity`, `delete_activity` |
| **Tags** (1) | `list_tags` |
| **Users & Account** (4) | `get_account`, `get_current_user`, `get_user`, `search_users` |
| **Reference lists** (8) | `list_activity_types`, `list_pipelines`, `list_pipeline_stages`, `list_pipeline_stages_by_pipeline`, `list_customer_sources`, `list_loss_reasons`, `list_lead_statuses`, `list_contact_types` |
| **Related items** (4) | `list_related_items`, `list_related_items_by_type`, `create_related_item`, `delete_related_item` |

**Leads** (11 tools) are implemented but not yet enabled — the tools exist in `src/tools/leads.js` and get wired in once the Copper account has the Leads feature turned on and they pass verification.

## Setup

```bash
npm install
cp .env.example .env    # then fill in your credentials
```

Environment variables (the running server uses `COPPER_*`; the test harness uses `COPPER_SANDBOX_*`):

- `COPPER_API_KEY`, `COPPER_USER_EMAIL`, `COPPER_USER_ID` — the account the server operates as
- `COPPER_SANDBOX_API_KEY`, `COPPER_SANDBOX_USER_EMAIL`, `COPPER_SANDBOX_USER_ID` — a separate sandbox account used only by the smoke tests (so production is never mutated)

## Run

```bash
npm start        # Streamable HTTP server on $PORT (default 8080); MCP endpoint at POST /mcp, health at GET /health
```

The Copper API key stays server-side and is never exposed to MCP clients.

## Authentication (OAuth 2.1)

`/mcp` is protected by OAuth when these env vars are set (leave them unset for open local dev):

| Env var | Set where | Purpose |
|---------|-----------|---------|
| `OAUTH_CLIENT_ID` | Cloud Run **and** the Claude connector | client id |
| `OAUTH_CLIENT_SECRET` | Cloud Run **and** the Claude connector | client secret |
| `OAUTH_JWT_SECRET` | Cloud Run only | signs access/refresh tokens — keep private |

Choose a `CLIENT_ID`/`CLIENT_SECRET` and set the **same pair** in both places; generate a strong `JWT_SECRET`:
`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

The server is a self-contained, **stateless** authorization server — it exposes OAuth discovery (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`), `/authorize`, and `/token`. Claude discovers these automatically, runs the authorization-code + PKCE flow, and sends `Authorization: Bearer …` on every MCP call. There is no per-user login (the server acts as a single Copper service account), so `/authorize` auto-approves — security rests on the client secret + PKCE. Tokens are short-lived HS256 JWTs, so nothing is stored (any Cloud Run instance validates any token).

**Connect in Claude:** add a custom connector with URL `https://<your-cloud-run-url>/mcp`, then enter `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` in its OAuth fields.

## Testing

`npm run smoke` boots the server in-memory and calls each tool through the real MCP protocol against the sandbox account; a check passes when Copper returns HTTP 200.

```bash
npm run smoke                          # all wired modules, read-only
npm run smoke -- --only companies      # a single module
npm run smoke -- --write               # also run create→delete write checks (sandbox only)
```

## License

MIT
