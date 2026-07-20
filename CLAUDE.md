# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP (Model Context Protocol) server that wraps the [Copper CRM REST API](https://developer.copper.com/), exposing Copper resources as MCP tools. It ships **67 tools** across 11 resource modules (people, companies, leads, opportunities, projects, tasks, activities, tags, users, reference lists, related items). Served over **Streamable HTTP** with OAuth for deployment (Cloud Run → Claude Chat / ChatGPT connectors).

- **Out of scope — intentionally not built (do not add):** Custom Fields, Connect Fields, Field Layouts, File Upload, Webhooks.

## Commands

```bash
npm install
npm start                              # run the Streamable HTTP server (listens on $PORT, default 8080)
npm run smoke                          # test all wired modules, read-only, against the sandbox
npm run smoke -- --only people         # test one module (works even if not yet wired in register.js)
npm run smoke -- --write               # also run write checks (create→delete on the sandbox)
npm run smoke -- --only leads --write  # combine
```

No build step or linter. `npm start`/`npm run smoke` auto-load `.env` via Node's `--env-file-if-exists`.

### Environment
The running server uses (validated at startup in `src/copper.js` — process exits if any is missing):
- `COPPER_API_KEY`, `COPPER_USER_EMAIL`, `COPPER_USER_ID`

The **smoke harness routes all traffic to a separate sandbox** so production is never mutated by tests:
- `COPPER_SANDBOX_API_KEY`, `COPPER_SANDBOX_USER_EMAIL`, `COPPER_SANDBOX_USER_ID`

**OAuth** (`src/oauth.js`) guards `POST /mcp`, enforced only when all three are set (unset = open, for local dev):
- `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` (also pasted into the Claude connector), `OAUTH_JWT_SECRET` (server-only). Self-contained stateless authorization server: HS256-JWT authorization-code + PKCE flow, single confidential client, `/authorize` auto-approves (one service account). Discovery at `/.well-known/oauth-protected-resource` + `/.well-known/oauth-authorization-server`. See README for setup.

## Architecture

ES modules (`"type": "module"`). `server.js` is transport-only; everything else lives in `src/`.

```
server.js            # express + StreamableHTTPServerTransport (STATELESS: fresh server+transport per POST /mcp);
                     #   /health for Cloud Run (NOT /healthz — Google reserves it); listens on $PORT
src/
  copper.js          # copperFetch(path,{method,body}) — the ONLY HTTP layer; HEADERS, BASE_URL,
                     #   env validation, USER_ID_NUM. Throws `Copper API <status>: <body>` on non-2xx.
  result.js          # jsonResult(data) / errorResult(msg) — MCP content wrappers
  resolve.js         # resolveParentName(type,id,cache) — {type,id} → human name, per-call Map cache
  register.js        # MODULES manifest + registerAll(server). Coordinator wires modules here.
  buildServer.js     # buildServer() → new McpServer + registerAll; tags each tool with read/action
                     #   annotations (readOnlyHint/destructiveHint) derived from its name prefix
  oauth.js           # stateless OAuth 2.1 AS guarding /mcp (discovery, /authorize, /token, Bearer)
  tools/<resource>.js# one module per resource; exports register(server) + smoke {read,write}
scripts/smoke.mjs    # test harness (see Testing)
todos/BUILDER-GUIDE.md  # the module contract every tool file follows — READ THIS before adding tools
todos/MCP Plan.md    # the parity plan + build log
```

**Request flow:** `POST /mcp` → `buildServer()` → `registerAll` calls each module's `register(server)` → tool handler → `copperFetch` → Copper. Stateless mode means a new server is built per request (fine on Cloud Run; no shared session state).

### Copper API conventions that shape the tools
- **Search is `POST /{resource}/search`** with a JSON body; pagination is `page_size` (default 20, **max 200**) + `page_number` (1-based) in the body. Regular reads are `GET /{resource}/{id}`.
- **CRUD verbs:** `POST /{resource}` (create), `PUT /{resource}/{id}` (update — send only changed fields), `DELETE /{resource}/{id}`. Bulk: `POST /{resource}/bulk_create|bulk_update` (max 10/request).
- **Some reads use POST** (`*/search`, `*/{id}/activities`, `people/fetch_by_email`) — still non-mutating.
- **Dates are Unix timestamps** (seconds). Exception: opportunity `close_date` is an `MM/DD/YYYY` string.
- **Parent references** use `{ type, id }` (`lead|person|company|opportunity|project|task`).
- ⚠️ **Copper's resource *overview* tables auto-render WRONG methods/paths** (e.g. PATCH for what is really PUT). Always trust the individual operation **sub-page**, not the overview table.

## Adding or extending a tool

**Read `todos/BUILDER-GUIDE.md` first** — it is the authoritative contract. In short:
- Each `src/tools/<resource>.js` exports `register(server)` (calls `server.tool(name, desc, zodShape, handler)` per op) and `smoke = { read, write }`.
- `.describe()` EVERY zod field. Trim list/search results; `get_*` returns the full record. Send only provided fields on create/update. Go through `copperFetch`.
- Add the module to `MODULES` in `src/register.js` to expose it. **Only wire a module once `npm run smoke -- --only <module> --write` is green** — untested tools stay unwired.
- New shared behavior goes in `src/copper.js`/`result.js`/`resolve.js` (coordinator-owned); tool files shouldn't edit shared files.

## Testing (`scripts/smoke.mjs`)

Boots the server in-memory and calls tools **through the MCP protocol** (zod → handler → Copper), so a check passes exactly when Copper returns **HTTP 200** (`copperFetch` throws otherwise). Each module's `smoke` export drives it:
- `read`: `{ tool, args }` or `async (ctx) => {}` — read-only, always run.
- `write`: `async (ctx) => {}` — create→[update]→delete, cleanup in `finally`; run only with `--write`.
- `ctx = { call(tool,args), fetch(path,opts), stamp }` — `call` = MCP tool (the assertion), `fetch` = raw copperFetch for cross-entity fixtures, `stamp` = unique run id (name test records `zzz_${stamp}`).
- A disabled Copper feature (403 "Feature not enabled", e.g. Leads on the sandbox) is reported **SKIP**, not FAIL.

## Copper API resources & documentation

Base API URL: `https://api.copper.com/developer_api/v1`. Full docs: https://developer.copper.com/. Trust operation sub-pages over overview tables.

### Implemented (wired)
- **People** — https://developer.copper.com/people/overview.html
- **Companies** — https://developer.copper.com/companies/overview.html
- **Leads** — https://developer.copper.com/leads/overview.html
- **Opportunities** — https://developer.copper.com/opportunities/overview.html
- **Projects** — https://developer.copper.com/projects/overview.html
- **Tasks** — https://developer.copper.com/tasks/overview.html
- **Activities** — https://developer.copper.com/activities/overview.html
- **Tags** — https://developer.copper.com/tags/overview.html
- **Account and Users** — https://developer.copper.com/account-and-users/overview.html
- **Related Items** — https://developer.copper.com/related-items/overview.html
- **Reference lists** (pipelines, pipeline stages, customer sources, loss reasons, lead statuses, contact types, activity types) — under the Leads/Opportunities/People/Activities docs

### Foundation docs
[Authentication](https://developer.copper.com/introduction/authentication.html) · [OAuth 2.0](https://developer.copper.com/introduction/oauth/index.html) · [Requests](https://developer.copper.com/introduction/requests.html) · [Responses](https://developer.copper.com/introduction/responses.html) · [Search](https://developer.copper.com/introduction/search.html) · [Pagination](https://developer.copper.com/introduction/pagination.html) · [Best Practices](https://developer.copper.com/introduction/best_practices.html) · [Change Policy](https://developer.copper.com/introduction/change_policy.html) · [Changelog](https://developer.copper.com/introduction/changelog.html)

## Implemented tools (67, wired)

Read-only tools (`get_*`/`search_*`/`list_*`) carry `readOnlyHint: true`; action tools (`create_*`/`update_*`/`delete_*`/`bulk_*`/`upsert_*`/`convert_*`) carry `readOnlyHint: false` (deletes also `destructiveHint: true`).

- **people** (9): search_people, get_person, get_person_by_email, create_person, bulk_create_people, update_person, bulk_update_people, delete_person, list_person_activities
- **companies** (8): search_companies, get_company, create_company, bulk_create_companies, update_company, bulk_update_companies, delete_company, list_company_activities
- **leads** (11): search_leads, get_lead, list_lead_activities, create_lead, bulk_create_leads, update_lead, bulk_update_leads, delete_lead, upsert_lead, upsert_lead_by_custom_field, convert_lead
- **opportunities** (6): search_opportunities, get_opportunity, create_opportunity, bulk_create_opportunities, update_opportunity, delete_opportunity
- **projects** (5): search_projects, get_project, create_project, update_project, delete_project
- **tasks** (5): search_tasks, get_task, create_task, update_task, delete_task
- **activities** (6): search_activities, get_activity, create_activity, bulk_create_activities, update_activity, delete_activity
- **tags** (1): list_tags
- **users** (4): get_account, get_current_user, get_user, search_users
- **reference** (8): list_activity_types, list_pipelines, list_pipeline_stages, list_pipeline_stages_by_pipeline, list_customer_sources, list_loss_reasons, list_lead_statuses, list_contact_types
- **relatedItems** (4): list_related_items, list_related_items_by_type, create_related_item, delete_related_item
