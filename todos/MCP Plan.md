# MCP Plan — Full Copper API Parity

Bring the `copper-mcp` server to **1:1 parity** with the Copper CRM REST API: every documented endpoint exposed as an MCP tool, built by parallel sub-agents coordinated by one lead, each self-verifying against a live Copper **sandbox** account (HTTP 200 = pass).

> Status legend: ✅ implemented & complete · 🟡 implemented but partial (expand) · ⬜ not yet built
> R/W legend: **R** = read-only (safe to smoke against any account) · **W** = write (create/update/delete/bulk — sandbox only) · ⚠️ = schema-mutating / high-risk

---

## Build status — 2026-07-17

**Complete. 67 tools wired, write-verified against the sandbox, deployed to Cloud Run behind OAuth.**

| Phase | Scope | Result |
|-------|-------|--------|
| 0 Foundation | `src/` refactor, `buildServer`, smoke harness, migrate 9 tools | ✅ |
| 1 Core CRM | people (9), companies (8), leads (11), opportunities (6), projects (5), tasks (5), activities (6) | ✅ |
| 2 Reference & relations | reference (8), users (4), tags (1), relatedItems (4) | ✅ |
| Annotations | read/action hints (`readOnlyHint`/`destructiveHint`) on every tool | ✅ 30 read / 26 action / 7 destructive |
| Auth | OAuth 2.1 on `/mcp` (`src/oauth.js`) | ✅ 15/15 flow checks; live returns 401 without token |
| Deploy | Cloud Run (`copper-mcp`, europe-west1) + OAuth env | ✅ live — 67 tools over authenticated `/mcp` |

Verification: `npm run smoke -- --write` → **49 passed / 0 failed / 0 skipped**. Live: `https://copper-mcp-27075326764.europe-west1.run.app/mcp`

**Advanced/admin surfaces (Custom Fields, Connect Fields, Field Layouts, File Upload, Webhooks) are out of scope — intentionally not built (per user).**

---

## 1. Decisions locked in

| Decision | Choice |
|----------|--------|
| **Write-tool testing** | A dedicated **sandbox Copper account** (arihealth) is used for all write-testing — its credentials live only in the gitignored `.env` as `COPPER_SANDBOX_*`. The production account (`COPPER_*`) is never mutated by tests. |
| **Scope** | **~67 tools, phased.** Core CRM + reference lists + users + tags + related items. All operations exposed incl. `delete_*` and bulk. **Advanced/admin surfaces (Custom Fields, Connect Fields, Field Layouts, File Upload, Webhooks) DROPPED — out of scope per user (2026-07-17); those tools will not be built.** |
| **Transport** | **Dual.** Keep **stdio** (local, Claude Code). Add **Streamable HTTP** via `express` → deploy to **Cloud Run**, registered as a remote MCP connector in **Claude Chat & ChatGPT** web apps. |
| **Build model** | **Sonnet 5** sub-agents implement one module each and self-verify (`smoke --only`). The **Opus orchestrator (me)** independently validates every deliverable — re-runs smoke, checks each tool against the doc — before accepting. See §5. |
| **Editing model** | Orchestrator owns `server.js`, `src/http.js` + shared `src/`. Sub-agents each own exactly one `src/tools/<resource>.js` → no shared-file conflicts (no git worktrees needed). |

### Prerequisites
- [x] Sandbox account provided (arihealth). **⚠️ [ ] Corrected API key needed — current one 401s (31 chars, expected 32).**
- [x] `express` purpose confirmed → Streamable HTTP transport for Cloud Run.
- [ ] Decide public-endpoint **auth** + which Copper account the deployed server uses — see §9.

---

## 2. Current state & gap

**Implemented (9 tools, in `server.js`):** `search_people`, `get_person`, `create_person`, `update_person` (🟡 partial — only `details`/`title`/`tags`), `search_companies`, `list_activity_types`, `create_activity`, `list_activities`, `list_opportunities`.

**Gap:** ~82 net-new tools + expand 3 existing (full field/filter coverage) + rename 2 for consistency (`list_opportunities`→`search_opportunities`, `list_activities`→`search_activities`, keeping backward-compatible behavior). Verified inventory: **16 resources, ~112 documented operations, ~91 unique tools** after deduplicating shared reference-list endpoints.

> ⚠️ **Doc trap (found during inventory):** Copper's resource *overview* tables auto-render **wrong** methods/paths (e.g. they show `update_person` as `PATCH`, `people/bulk` as `PATCH`, `fetch_by_email` as `GET`, `List Users` as `GET /users`, webhook update as `PATCH`). The individual operation **sub-pages are authoritative** — this plan's tables use the sub-page values. Always trust the sub-page, never the overview table.

---

## 3. Target architecture (Phase 0 refactor)

```
copper-mcp/
  server.js                # entry: pick transport — stdio (local) or HTTP (Cloud Run, when PORT/--http set)
  src/
    copper.js              # BASE_URL, HEADERS, env validation, copperFetch(path,{method,body})
    result.js              # jsonResult(data), errorResult(msg)
    resolve.js             # resolveParentName(type,id,cache) + shared name-cache helpers
    register.js            # registerAll(server): imports every tools/*.js and calls its register()
    buildServer.js         # factory: new McpServer(...) + registerAll → returns a configured server
    http.js                # express app + StreamableHTTPServerTransport (stateless), /mcp route, auth middleware
    tools/
      people.js  companies.js  leads.js  opportunities.js  projects.js
      tasks.js   activities.js  tags.js  users.js  reference.js
      relatedItems.js
  scripts/
    smoke.mjs              # test harness (see §4)
  Dockerfile               # Cloud Run container (node:22-alpine, listens on $PORT)
  .dockerignore
  todos/MCP Plan.md        # this file
```

**Module contract** — every `src/tools/<resource>.js` exports:
```js
export function register(server) {
  server.tool(name, description, zodShape, handler);   // one per operation
}
// Smoke checks for THIS module (see §4). read[] are declarative; write[] are functions that chain calls.
export const smoke = {
  read:  [ { tool: "search_people", args: { page_size: 1 } }, /* … */ ],
  write: [ async (call) => {                       // create → [update] → delete, cleanup in finally
             const created = await call("create_person", { first_name: "zzz_mcp", last_name: `smoke_${STAMP}` });
             const id = created.id;
             try { await call("update_person", { person_id: id, title: "smoke" }); }
             finally { await call("delete_person", { person_id: id }); }
           } ],
};
```
Reuse the existing helpers and the tool-authoring conventions already documented in **CLAUDE.md** (`.describe()` every field, trim list results, only send provided fields on update, snake_case names). This refactor keeps all 9 current tools working — it only relocates them.

**Transport (dual).** `buildServer()` returns a configured `McpServer`; `server.js` selects how to serve it:
- **stdio** — default for local use (Claude Code), exactly as today.
- **HTTP** — when `PORT` (Cloud Run injects it) or `--http` is set. `src/http.js` runs an express app exposing `POST /mcp` (plus `GET`/`DELETE /mcp`) backed by `StreamableHTTPServerTransport` in **stateless mode** (a fresh server+transport per request) so it scales horizontally on Cloud Run with no cross-instance session state. Listen on `process.env.PORT` (default 8080), bind `0.0.0.0`, add `GET /healthz`. An **auth middleware** guards `/mcp` (see §9 — a public MCP endpoint over a delete/bulk-capable CRM must not be unauthenticated). The Copper API key stays server-side in env and is never exposed to MCP clients.

---

## 4. Testing method — smoke harness

**Principle (per the user):** the simplest reliable signal is *"call it against the API and get HTTP 200."* `copperFetch` already throws on any non-2xx, so a tool call that does **not** throw = 200 = pass.

`scripts/smoke.mjs` (run via `npm run smoke`):
1. **Full-path test, not just the HTTP layer.** Build the `McpServer` via `registerAll`, connect an in-memory MCP `Client` over `InMemoryTransport`, and invoke tools **by name through the MCP protocol**. This exercises zod validation → handler → `copperFetch` → Copper — the real tool, end to end.
2. **Credential routing.** Read checks use whatever creds are present. **Write checks require the sandbox creds** (`COPPER_SANDBOX_*`) **and** `COPPER_SMOKE_WRITE=1`; otherwise they are skipped with a logged notice. Writes never run against production.
3. **ID discovery.** Before read checks that need an id (`get_*`, `list_*_activities`, files), call the entity's `search_*` with `page_size:1` to grab a real id. If the account has zero records of that type, **skip + log** (not a failure).
4. **Write checks** create a uniquely-named throwaway record (prefix `zzz_mcp_smoke_<timestamp>`), optionally update it, and **delete it in a `finally`** so the sandbox stays clean.
5. **Filtering for sub-agents:** `npm run smoke -- --only <module>` runs one module's checks — this is how a sub-agent verifies its own work in isolation.
6. **Output:** a per-tool PASS/SKIP/FAIL table; process exits non-zero if anything failed.

`package.json` scripts to add: `"smoke": "node --env-file-if-exists=.env scripts/smoke.mjs"`.

**Acceptance for any tool = its smoke check returns 200** (read: direct; write: full create→delete cycle on the sandbox).

---

## 5. Execution process

```
Phase 0  Orchestrator (sequential, BLOCKING) — foundation
         └─ refactor to src/ modules + buildServer factory; migrate 9 existing tools
         └─ add dual transport (stdio + src/http.js Streamable HTTP) + build smoke.mjs
         └─ GATE: stdio boots + HTTP /mcp answers an `initialize` locally + smoke green for existing tools

Phase 1  Sonnet-5 sub-agents in parallel — one file each (core CRM):
         leads · people(complete) · companies(complete) · opportunities(complete)
         projects · tasks · activities(complete)
         └─ each: implement all ops + smoke{read,write}; self-test `smoke --only <m>` → 200
         └─ Orchestrator VALIDATES each (re-runs smoke + doc check) → GATE: full smoke green

Phase 2  Sonnet-5 sub-agents in parallel: reference · users · tags · relatedItems
         └─ Orchestrator validates → GATE: full smoke green

Phase 4  Orchestrator — integration & docs
         └─ wire registerAll, reconcile tool count vs inventory (67),
            update README + CLAUDE.md tool tables, final full smoke

Phase 5  Orchestrator — deploy (Cloud Run)
         └─ Dockerfile + $PORT listen; auth middleware on /mcp; deploy; register the
            HTTPS URL as a remote MCP connector in Claude Chat & ChatGPT; smoke the live URL
```

### Orchestration & validation protocol (user-directed)
Builders run on **Sonnet 5** (`model: sonnet`); the orchestrator (this Opus session) validates. Per module:
1. **Brief** — the sub-agent gets its exact operation table (method/path/R-W/doc URL) + conventions from §6/§7, the CLAUDE.md authoring rules, and a **checkable contract**: implement `register` + `smoke`, run `npm run smoke -- --only <module>` against the sandbox, and report files changed, smoke output, and any doc ambiguity. No open-ended tasks — each agent verifies exactly the endpoints it was given.
2. **Validate (never trust a green claim)** — the orchestrator independently: (a) reads the code; (b) checks every tool's method/path/body against the plan inventory, re-reading the Copper doc when ambiguous; (c) **re-runs `smoke --only <module>` itself**; (d) confirms zod `.describe()` coverage + result trimming; (e) confirms write checks create→delete with cleanup. Fail → fix inline or return to the agent with specifics.

**Sub-agent brief (per module):** given the operation table below (method/path/R-W/docUrl) + the resource's conventions, produce `src/tools/<module>.js` (`register` + `smoke`) following CLAUDE.md conventions, then run `npm run smoke -- --only <module>` and iterate until every check is 200. Do **not** edit `server.js` or `src/*` shared files — surface any needed shared-helper change to the coordinator.

---

## 6. Task breakdown (the tool list)

Base URL `https://api.copper.com/developer_api/v1`. Tool names link to their Copper doc page.

### Phase 1 — Core CRM entities

#### `leads.js` — [Leads](https://developer.copper.com/leads/overview.html)
| Tool | Method & Path | R/W | Status |
|------|---------------|-----|--------|
| [get_lead](https://developer.copper.com/leads/fetch-a-lead-by-id.html) | `GET /leads/{id}` | R | ⬜ |
| [create_lead](https://developer.copper.com/leads/create-a-new-lead.html) | `POST /leads` | W | ⬜ |
| [bulk_create_leads](https://developer.copper.com/leads/bulk-create-leads.html) | `POST /leads/bulk_create` | W | ⬜ |
| [update_lead](https://developer.copper.com/leads/update-a-lead.html) | `PUT /leads/{id}` | W | ⬜ |
| [bulk_update_leads](https://developer.copper.com/leads/bulk-update-leads.html) | `POST /leads/bulk_update` | W | ⬜ |
| [delete_lead](https://developer.copper.com/leads/delete-a-lead.html) | `DELETE /leads/{id}` | W | ⬜ |
| [upsert_lead](https://developer.copper.com/leads/upsert-a-lead.html) | `PUT /leads/upsert` (match by email) | W | ⬜ |
| [upsert_lead_by_custom_field](https://developer.copper.com/leads/upsert-a-lead-by-custom-field.html) | `PUT /leads/upsert` (match in body) | W | ⬜ |
| [convert_lead](https://developer.copper.com/leads/convert-a-lead.html) | `POST /leads/{id}/convert` | W | ⬜ |
| [search_leads](https://developer.copper.com/leads/list-leads-search.html) | `POST /leads/search` | R | ⬜ |
| [list_lead_activities](https://developer.copper.com/leads/see-a-leads-activities.html) | `POST /leads/{id}/activities` | R | ⬜ |

#### `people.js` — [People](https://developer.copper.com/people/overview.html)
| Tool | Method & Path | R/W | Status |
|------|---------------|-----|--------|
| [get_person](https://developer.copper.com/people/fetch-a-person-by-id.html) | `GET /people/{id}` | R | ✅ |
| [get_person_by_email](https://developer.copper.com/people/fetch-a-person-by-email.html) | `POST /people/fetch_by_email` | R | ⬜ |
| [create_person](https://developer.copper.com/people/create-a-new-person.html) | `POST /people` | W | ✅ (expand fields) |
| [bulk_create_people](https://developer.copper.com/people/bulk-create-people.html) | `POST /people/bulk_create` (max 10) | W | ⬜ |
| [update_person](https://developer.copper.com/people/update-a-person.html) | `PUT /people/{id}` | W | 🟡 partial → full fields |
| [bulk_update_people](https://developer.copper.com/people/bulk-update-people.html) | `POST /people/bulk_update` (max 10) | W | ⬜ |
| [delete_person](https://developer.copper.com/people/delete-a-person.html) | `DELETE /people/{id}` | W | ⬜ |
| [search_people](https://developer.copper.com/people/list-people-search.html) | `POST /people/search` | R | ✅ (expand filters) |
| [list_person_activities](https://developer.copper.com/people/see-a-persons-activities.html) | `POST /people/{id}/activities` | R | ⬜ |

#### `companies.js` — [Companies](https://developer.copper.com/companies/overview.html)
| Tool | Method & Path | R/W | Status |
|------|---------------|-----|--------|
| [get_company](https://developer.copper.com/companies/fetch-a-company-by-id.html) | `GET /companies/{id}` | R | ⬜ |
| [create_company](https://developer.copper.com/companies/create-a-new-company.html) | `POST /companies` | W | ⬜ |
| [bulk_create_companies](https://developer.copper.com/companies/bulk-company-create.html) | `POST /companies/bulk_create` | W | ⬜ |
| [update_company](https://developer.copper.com/companies/update-a-company.html) | `PUT /companies/{id}` | W | ⬜ |
| [bulk_update_companies](https://developer.copper.com/companies/bulk-company-update.html) | `POST /companies/bulk_update` | W | ⬜ |
| [delete_company](https://developer.copper.com/companies/delete-a-company.html) | `DELETE /companies/{id}` | W | ⬜ |
| [search_companies](https://developer.copper.com/companies/list-companies-search.html) | `POST /companies/search` | R | ✅ (expand filters) |
| [list_company_activities](https://developer.copper.com/companies/see-a-companys-activities.html) | `POST /companies/{id}/activities` | R | ⬜ |

#### `opportunities.js` — [Opportunities](https://developer.copper.com/opportunities/overview.html)
| Tool | Method & Path | R/W | Status |
|------|---------------|-----|--------|
| [get_opportunity](https://developer.copper.com/opportunities/fetch-an-opportunity-by-id.html) | `GET /opportunities/{id}` | R | ⬜ |
| [create_opportunity](https://developer.copper.com/opportunities/create-a-new-opportunity.html) | `POST /opportunities` | W | ⬜ |
| [bulk_create_opportunities](https://developer.copper.com/opportunities/bulk-create-opportunities.html) | `POST /opportunities/bulk_create` (max 10) | W | ⬜ |
| [update_opportunity](https://developer.copper.com/opportunities/update-an-opportunity.html) | `PUT /opportunities/{id}` | W | ⬜ |
| [delete_opportunity](https://developer.copper.com/opportunities/delete-an-opportunity.html) | `DELETE /opportunities/{id}` | W | ⬜ |
| [search_opportunities](https://developer.copper.com/opportunities/list-opportunities-search.html) | `POST /opportunities/search` | R | 🟡 rename from `list_opportunities`, expand filters |

> No `bulk_update` or `fetch_by_email` exists for Opportunities (confirmed absent).

#### `projects.js` — [Projects](https://developer.copper.com/projects/overview.html)
| Tool | Method & Path | R/W | Status |
|------|---------------|-----|--------|
| [get_project](https://developer.copper.com/projects/fetch-a-project-by-id.html) | `GET /projects/{id}` | R | ⬜ |
| [create_project](https://developer.copper.com/projects/create-a-new-project.html) | `POST /projects` | W | ⬜ |
| [update_project](https://developer.copper.com/projects/update-a-project.html) | `PUT /projects/{id}` | W | ⬜ |
| [delete_project](https://developer.copper.com/projects/delete-a-project.html) | `DELETE /projects/{id}` | W | ⬜ |
| [search_projects](https://developer.copper.com/projects/list-projects-search.html) | `POST /projects/search` | R | ⬜ |

#### `tasks.js` — [Tasks](https://developer.copper.com/tasks/overview.html)
| Tool | Method & Path | R/W | Status |
|------|---------------|-----|--------|
| [get_task](https://developer.copper.com/tasks/fetch-a-task-by-id.html) | `GET /tasks/{id}` | R | ⬜ |
| [create_task](https://developer.copper.com/tasks/create-a-new-task.html) | `POST /tasks` | W | ⬜ |
| [update_task](https://developer.copper.com/tasks/update-a-task.html) | `PUT /tasks/{id}` | W | ⬜ |
| [delete_task](https://developer.copper.com/tasks/delete-a-task.html) | `DELETE /tasks/{id}` | W | ⬜ |
| [search_tasks](https://developer.copper.com/tasks/list-tasks-search.html) | `POST /tasks/search` | R | ⬜ |

#### `activities.js` — [Activities](https://developer.copper.com/activities/overview.html)
| Tool | Method & Path | R/W | Status |
|------|---------------|-----|--------|
| [get_activity](https://developer.copper.com/activities/fetch-an-activity-by-id.html) | `GET /activities/{id}` | R | ⬜ |
| [create_activity](https://developer.copper.com/activities/create-a-new-activity.html) | `POST /activities` | W | ✅ |
| [bulk_create_activities](https://developer.copper.com/activities/bulk-create-activities.html) | `POST /activities/bulk_create` (max 10) | W | ⬜ |
| [update_activity](https://developer.copper.com/activities/update-an-activity.html) | `PUT /activities/{id}` | W | ⬜ |
| [delete_activity](https://developer.copper.com/activities/delete-an-activity.html) | `DELETE /activities/{id}` | W | ⬜ |
| [search_activities](https://developer.copper.com/activities/list-activities-search.html) | `POST /activities/search` | R | 🟡 rename from `list_activities` (keep parent-name resolution + system-filter) |

> `list_activity_types` (`GET /activity_types`) moves to `reference.js`.

### Phase 2 — Reference & relationships

#### `reference.js` — shared enums/dropdowns (used across entities)
| Tool | Method & Path | R/W | Status |
|------|---------------|-----|--------|
| [list_activity_types](https://developer.copper.com/activities/list-activity-types.html) | `GET /activity_types` | R | ✅ (move here) |
| [list_pipelines](https://developer.copper.com/opportunities/list-pipelines.html) | `GET /pipelines` | R | ⬜ |
| [list_pipeline_stages](https://developer.copper.com/opportunities/list-pipeline-stages.html) | `GET /pipeline_stages` | R | ⬜ |
| [list_pipeline_stages_by_pipeline](https://developer.copper.com/opportunities/list-stages-in-a-pipeline.html) | `GET /pipeline_stages/pipeline/{pipeline_id}` | R | ⬜ |
| [list_customer_sources](https://developer.copper.com/opportunities/list-customer-sources.html) | `GET /customer_sources` | R | ⬜ |
| [list_loss_reasons](https://developer.copper.com/opportunities/list-loss-reasons.html) | `GET /loss_reasons` | R | ⬜ |
| [list_lead_statuses](https://developer.copper.com/leads/list-lead-statuses.html) | `GET /lead_statuses` | R | ⬜ |
| [list_contact_types](https://developer.copper.com/people/list-contact-types.html) | `GET /contact_types` | R | ⬜ |

#### `users.js` — [Account & Users](https://developer.copper.com/account-and-users/overview.html) (read-only resource)
| Tool | Method & Path | R/W | Status |
|------|---------------|-----|--------|
| [get_account](https://developer.copper.com/account-and-users/fetch-account-details.html) | `GET /account` | R | ⬜ |
| [get_user](https://developer.copper.com/account-and-users/fetch-user-by-id.html) | `GET /users/{id}` | R | ⬜ |
| [get_current_user](https://developer.copper.com/account-and-users/fetch-api-user.html) | `GET /users/me` | R | ⬜ |
| [search_users](https://developer.copper.com/account-and-users/list-users.html) | `POST /users/search` | R | ⬜ |

#### `tags.js` — [Tags](https://developer.copper.com/tags/overview.html) (read-only resource)
| Tool | Method & Path | R/W | Status |
|------|---------------|-----|--------|
| [list_tags](https://developer.copper.com/tags/list-tags.html) | `GET /tags` (`tag_names_only`, cursor via `last_tag_value`) | R | ⬜ |

#### `relatedItems.js` — [Related Items](https://developer.copper.com/related-items/overview.html)
| Tool | Method & Path | R/W | Status |
|------|---------------|-----|--------|
| [list_related_items](https://developer.copper.com/related-items/view-all-records-related-to-an-entity.html) | `GET /{entity}/{id}/related` | R | ⬜ |
| [list_related_items_by_type](https://developer.copper.com/related-items/view-all-records-of-a-given-entity-type-related-to-an-entity.html) | `GET /{entity}/{id}/related/{related_entity}` | R | ⬜ |
| [create_related_item](https://developer.copper.com/related-items/relate-an-existing-record-to-an-entity.html) | `POST /{entity}/{id}/related` (body `{resource:{id,type}}`) | W | ⬜ |
| [delete_related_item](https://developer.copper.com/related-items/remove-relationship-between-record-and-entity.html) | `DELETE /{entity}/{id}/related` (⚠️ **JSON body**, not path) | W | ⬜ |

---

## 7. Cross-cutting conventions (apply to every module)

- **Search is `POST /{resource}/search`** with body pagination: `page_number` (1-based, default 1), `page_size` (default 20, **max 200**), plus `sort_by`/`sort_direction`. Multiple filters = AND. Results capped at first ~100,000 records.
- **Some reads use POST** (`fetch_by_email`, `*/search`, `*/{id}/activities`) — these are **R** (non-destructive) despite the verb.
- **Dates** are Unix timestamps (seconds).
- **Parent references** use `{type, id}`; `type` ∈ `lead|person|company|opportunity|project|task`.
- **`X-PW-Application` header** — code currently sends `developer_api`; docs example uses `developer`. Both are accepted; leave as-is (already working, verified 200).
- Update tools send **only provided fields**. List/search tools **trim** to useful fields; `get_*` may return the full record.

---

## 8. Definition of done

- [ ] All ~91 tools registered; `registerAll` wires every `src/tools/*.js`.
- [ ] `npm run smoke` — **all read checks 200**; **all write checks 200 against the sandbox** (create→delete, no residue).
- [ ] Tool count reconciled against this inventory (no endpoint missed; intentional exclusions — S3 upload helper, computed-values flag, custom-field search filter — documented).
- [ ] Server boots over stdio; MCP client lists the full tool set.
- [ ] README tool table + CLAUDE.md "implemented tools" list updated.
- [ ] The 9 original tools still pass (no regression from the refactor).
- [ ] **HTTP transport:** `POST /mcp` handles an MCP `initialize` + `tools/list` + a read `tools/call` locally; stdio still works.
- [ ] **Deployed** to Cloud Run on `$PORT` behind auth; live URL smoke-tested; connected in Claude Chat & ChatGPT.

---

## 9. Open items — resolved

1. **Sandbox account** — a corrected key for the arihealth sandbox works; write-tests run against it via `COPPER_SANDBOX_*` (kept only in the gitignored `.env`). ✅
2. **`/mcp` auth** — embedded stateless **OAuth 2.1** authorization server (`src/oauth.js`): discovery + `/authorize` + `/token` + Bearer guard, one predefined confidential client + PKCE. ✅
3. **Deployed server identity** — single Copper service account via the Cloud Run `COPPER_*` env (not per-user). ✅
4. **Cloud Run** — stateless MCP mode (fresh server per request; no server-initiated notifications). ✅
