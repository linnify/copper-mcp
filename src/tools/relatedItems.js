import { z } from "zod";
import { copperFetch } from "../copper.js";
import { jsonResult } from "../result.js";
import { resolveParentName } from "../resolve.js";

// Related Items. https://developer.copper.com/related-items/overview.html
// Full parity: list all related items, list related items filtered by one type, relate an
// existing record, and unrelate a record — the 4 operations from the resource's sub-pages. Per
// the coordinator's warning, the overview table's auto-rendered shape for relate/unrelate was NOT
// trusted; each sub-page was read directly instead:
//   GET    /{entity}/{entity_id}/related                  - view-all-records-related-to-an-entity.html
//   GET    /{entity}/{entity_id}/related/{related_entity}  - view-all-records-of-a-given-entity-type-related-to-an-entity.html
//   POST   /{entity}/{entity_id}/related                  - relate-an-existing-record-to-an-entity.html
//   DELETE /{entity}/{entity_id}/related                  - remove-relationship-between-record-and-entity.html
//
// Doc facts confirmed from the sub-pages' own working curl examples (see report for the one place
// a sub-page's prose contradicted its own example):
// - `{entity}`/`{entity_id}` is the plural collection segment + numeric id of whichever record
//   you're viewing/modifying relations FROM (people, companies, opportunities, leads, projects,
//   tasks) — the same convention every other module in this repo already uses for its own
//   resource, so it's reused verbatim here as `entity_type`/`entity_id`.
// - `{related_entity}` on the "list by type" sub-page is PLURAL (its own example curl hits
//   `/people/{id}/related/opportunities`), even though that same sub-page's prose mislabels it as
//   singular. The working example was trusted over the prose.
// - Both create and delete send a JSON body `{ "resource": { "id": <number>, "type": "<string>" } }`
//   where `type` is SINGULAR (lead|person|company|opportunity|project|task) — confirmed by the
//   example response echoing the same shape back (`{ "added": true, "resource": {...} }` /
//   `{ "removed": true, "resource": {...} }`). This is the one place the overview's untrusted table
//   would have led to a wrong shape (it implies path-only params with no body). The DELETE really
//   does carry a body — copperFetch (src/copper.js) already supports that for any method.
// - Relating/unrelating never creates or deletes the underlying record — both records must already
//   exist. This resource only manages the link between them.
// - The overview page documents relationship-compatibility rules and per-pair limits (e.g. a
//   Person can have at most one related Company; a Task can have only one related item, period;
//   Leads can only relate to Tasks). None of that is validated client-side here — the exact matrix
//   isn't guaranteed stable, Copper already rejects an incompatible pair with a 4xx, and baking a
//   possibly-stale matrix into this schema risks blocking a legitimate call. Surfaced as a caveat
//   in the tool descriptions instead.
// - The API's raw related-item shape is just `{ id, type }` (type singular) with no name — this
//   module resolves a human-readable `name` via resolveParentName (src/resolve.js) for each result,
//   same pattern as search_activities' `parent_name` in activities.js. resolveParentName only knows
//   person/company/lead/opportunity endpoints, so project/task related items gracefully fall back
//   to its built-in `"project #12345"`-style stub rather than a real name (see report).

const ENTITY_TYPES = ["people", "companies", "opportunities", "leads", "projects", "tasks"];
const RESOURCE_TYPES = ["lead", "person", "company", "opportunity", "project", "task"];

// Resolve {id,type} related-item stubs to include a best-effort human-readable name, caching
// lookups per call so repeated ids/types in one result set only hit the API once each.
async function withResolvedNames(items) {
  const cache = new Map();
  return Promise.all(
    (items || []).map(async (item) => ({
      id: item.id,
      type: item.type,
      name: await resolveParentName(item.type, item.id, cache),
    }))
  );
}

export function register(server) {
  // --- List Related Items ---
  server.tool(
    "list_related_items",
    "List every record related to a Copper entity, across all related types at once (companies, people, opportunities, projects, tasks, leads — whichever apply). Each result includes the related record's id, type, and a best-effort resolved name. Use search_people/search_companies/search_opportunities/etc. first to find entity_id.",
    {
      entity_type: z.enum(ENTITY_TYPES).describe("Plural collection name of the entity to list related items for: people, companies, opportunities, leads, projects, or tasks"),
      entity_id: z.number().describe("Copper ID of the entity to list related items for"),
    },
    async ({ entity_type, entity_id }) => {
      const results = await copperFetch(`/${entity_type}/${entity_id}/related`);
      return jsonResult(await withResolvedNames(results));
    }
  );

  // --- List Related Items By Type ---
  server.tool(
    "list_related_items_by_type",
    "List only the records of one specific type related to a Copper entity (e.g. just the opportunities related to a person, ignoring any related companies/tasks/etc.). Use list_related_items instead if you want every related type at once.",
    {
      entity_type: z.enum(ENTITY_TYPES).describe("Plural collection name of the entity to list related items for: people, companies, opportunities, leads, projects, or tasks"),
      entity_id: z.number().describe("Copper ID of the entity to list related items for"),
      related_entity_type: z.enum(ENTITY_TYPES).describe("Plural collection name of the related type to filter to: people, companies, opportunities, leads, projects, or tasks"),
    },
    async ({ entity_type, entity_id, related_entity_type }) => {
      const results = await copperFetch(`/${entity_type}/${entity_id}/related/${related_entity_type}`);
      return jsonResult(await withResolvedNames(results));
    }
  );

  // --- Create Related Item ---
  server.tool(
    "create_related_item",
    "Relate an existing Copper record to another existing record (e.g. link a company to a person, or a task to an opportunity). Both records must already exist — this only creates the link, never the underlying records. Relationships are bidirectional, so it doesn't matter which record you call this against. Copper restricts which type pairs may be related and enforces limits on some (e.g. a person can have at most one related company; a task can have only one related item total) — an incompatible or over-limit pairing is rejected by the API.",
    {
      entity_type: z.enum(ENTITY_TYPES).describe("Plural collection name of the entity to relate the resource to: people, companies, opportunities, leads, projects, or tasks"),
      entity_id: z.number().describe("Copper ID of the entity to relate the resource to"),
      resource_type: z.enum(RESOURCE_TYPES).describe("Singular type of the existing record being related: lead, person, company, opportunity, project, or task"),
      resource_id: z.number().describe("Copper ID of the existing record being related"),
    },
    async ({ entity_type, entity_id, resource_type, resource_id }) => {
      const body = { resource: { id: resource_id, type: resource_type } };
      const result = await copperFetch(`/${entity_type}/${entity_id}/related`, { method: "POST", body });
      return jsonResult(result);
    }
  );

  // --- Delete Related Item ---
  server.tool(
    "delete_related_item",
    "Remove the relationship between two existing Copper records — deletes only the link, never either record. Use list_related_items or list_related_items_by_type first to confirm the exact resource_type/resource_id pair that's currently related.",
    {
      entity_type: z.enum(ENTITY_TYPES).describe("Plural collection name of the entity to unrelate the resource from: people, companies, opportunities, leads, projects, or tasks"),
      entity_id: z.number().describe("Copper ID of the entity to unrelate the resource from"),
      resource_type: z.enum(RESOURCE_TYPES).describe("Singular type of the related record to remove: lead, person, company, opportunity, project, or task"),
      resource_id: z.number().describe("Copper ID of the related record to remove"),
    },
    async ({ entity_type, entity_id, resource_type, resource_id }) => {
      const body = { resource: { id: resource_id, type: resource_type } };
      const result = await copperFetch(`/${entity_type}/${entity_id}/related`, { method: "DELETE", body });
      return jsonResult(result);
    }
  );
}

// Smoke checks. Run: npm run smoke -- --only relatedItems --write
//
// `--only relatedItems` registers ONLY this module's tools on the smoke server (see
// scripts/smoke.mjs) — cross-entity fixtures (a person, a company) must therefore come from
// ctx.fetch (raw copperFetch), not call("create_person"/"create_company", ...), since those tools
// live in other modules that aren't registered in this isolated run.
//
// Read checks stay mutation-free (repo convention — read[] has no sandbox/--write gate in
// scripts/smoke.mjs, unlike write[]): they look for an already-existing person/company via a raw
// search and skip quietly if the sandbox has none. The write check below creates its own fixtures
// and is the real coverage for both list tools, since it's guaranteed to have a live relation to find.
export const smoke = {
  read: [
    async ({ fetch, call }) => {
      const found = await fetch("/people/search", { method: "POST", body: { page_size: 1 } });
      if (found?.length) await call("list_related_items", { entity_type: "people", entity_id: found[0].id });
    },
    async ({ fetch, call }) => {
      const found = await fetch("/companies/search", { method: "POST", body: { page_size: 1 } });
      if (found?.length) {
        await call("list_related_items_by_type", {
          entity_type: "companies",
          entity_id: found[0].id,
          related_entity_type: "people",
        });
      }
    },
  ],
  write: [
    // create person + company fixtures -> relate company to person -> confirm via both list
    // tools -> unrelate -> delete both fixtures in finally.
    async ({ call, fetch, stamp }) => {
      const person = await fetch("/people", { method: "POST", body: { name: `zzz_${stamp}` } });
      const company = await fetch("/companies", { method: "POST", body: { name: `zzz_${stamp}` } });
      try {
        await call("create_related_item", {
          entity_type: "people",
          entity_id: person.id,
          resource_type: "company",
          resource_id: company.id,
        });

        const related = await call("list_related_items", { entity_type: "people", entity_id: person.id });
        const linked = related?.some((r) => r.id === company.id && r.type === "company");
        if (!linked) throw new Error(`create_related_item didn't show up in list_related_items: ${JSON.stringify(related)}`);

        const relatedByType = await call("list_related_items_by_type", {
          entity_type: "people",
          entity_id: person.id,
          related_entity_type: "companies",
        });
        const linkedByType = relatedByType?.some((r) => r.id === company.id && r.type === "company");
        if (!linkedByType) throw new Error(`create_related_item didn't show up in list_related_items_by_type: ${JSON.stringify(relatedByType)}`);

        await call("delete_related_item", {
          entity_type: "people",
          entity_id: person.id,
          resource_type: "company",
          resource_id: company.id,
        });
      } finally {
        await fetch(`/people/${person.id}`, { method: "DELETE" });
        await fetch(`/companies/${company.id}`, { method: "DELETE" });
      }
    },
  ],
};
