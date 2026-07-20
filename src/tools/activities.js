import { z } from "zod";
import { copperFetch, USER_ID_NUM } from "../copper.js";
import { jsonResult } from "../result.js";
import { resolveParentName } from "../resolve.js";

// Activities. https://developer.copper.com/activities/overview.html
// Full parity: get, create, bulk_create, update, delete, search — all 6 operations from the
// resource's sub-pages (the overview table's methods were not trusted; each sub-page was read
// directly). (list_activity_types lives in reference.js — it's a top-level /activity_types
// endpoint, not scoped to a single activity.)
//
// Only "user" category activities can be created or modified via the API — "system" activities
// (assignee/status changes, etc.) are read-only (see search_activities' include_system flag).

// Parent types an activity can be logged against (shared by create_activity, bulk_create_activities,
// and search_activities' filter).
const PARENT_TYPES = ["lead", "person", "company", "opportunity", "project", "task"];

export function register(server) {
  // --- Get Activity ---
  server.tool(
    "get_activity",
    "Get full details of a Copper activity (note, call, meeting, etc.) by its ID. Use search_activities first to find an activity_id.",
    {
      activity_id: z.number().describe("Copper activity ID"),
    },
    async ({ activity_id }) => {
      const activity = await copperFetch(`/activities/${activity_id}`);
      return jsonResult(activity);
    }
  );

  // --- Create Activity ---
  server.tool(
    "create_activity",
    "Log an activity (meeting note, phone call, etc.) against a Copper lead, person, company, opportunity, project, or task. Use list_activity_types first to get the correct activity_type_id.",
    {
      parent_type: z.enum(PARENT_TYPES).describe("Type of record to log against"),
      parent_id: z.number().describe("Copper ID of the parent record"),
      activity_type_id: z.number().describe("Activity type ID (from list_activity_types)"),
      details: z.string().describe("Activity content — meeting notes, action items, summary, etc. Use plain text, not markdown."),
      activity_date: z.number().optional().describe("Unix timestamp for when the activity occurred (default: now)"),
    },
    async ({ parent_type, parent_id, activity_type_id, details, activity_date }) => {
      const body = {
        parent: { type: parent_type, id: parent_id },
        type: { id: activity_type_id, category: "user" },
        user_id: USER_ID_NUM,
        details,
      };
      if (activity_date) body.activity_date = activity_date;

      const result = await copperFetch("/activities", { method: "POST", body });
      return jsonResult({
        id: result.id,
        parent: result.parent,
        type: result.type,
        details: result.details,
        activity_date: result.activity_date,
      });
    }
  );

  // --- Bulk Create Activities ---
  server.tool(
    "bulk_create_activities",
    "Log up to 10 activities in Copper in a single request. Each entry accepts the same fields as create_activity — use list_activity_types first to get the correct activity_type_id.",
    {
      activities: z
        .array(
          z.object({
            parent_type: z.enum(PARENT_TYPES).describe("Type of record to log against"),
            parent_id: z.number().describe("Copper ID of the parent record"),
            activity_type_id: z.number().describe("Activity type ID (from list_activity_types)"),
            details: z.string().describe("Activity content — meeting notes, action items, summary, etc. Use plain text, not markdown."),
            activity_date: z.number().optional().describe("Unix timestamp for when the activity occurred (default: now)"),
          })
        )
        .min(1)
        .max(10)
        .describe("Activities to create (1-10 per request — Copper's bulk-create limit)"),
    },
    async ({ activities }) => {
      const payload = activities.map((a) => {
        const body = {
          parent: { type: a.parent_type, id: a.parent_id },
          type: { id: a.activity_type_id, category: "user" },
          user_id: USER_ID_NUM,
          details: a.details,
        };
        if (a.activity_date) body.activity_date = a.activity_date;
        return body;
      });

      const results = await copperFetch("/activities/bulk_create", { method: "POST", body: { activities: payload } });
      // Failed entries come back as { success: false, message: {...} } instead of a full activity
      // record — pass those through as-is rather than trimming them into an empty stub.
      const activitiesOut = results.map((r) =>
        r?.success === false
          ? r
          : { id: r.id, parent: r.parent, type: r.type, details: r.details, activity_date: r.activity_date }
      );
      return jsonResult(activitiesOut);
    }
  );

  // --- Update Activity ---
  server.tool(
    "update_activity",
    "Update an existing Copper activity's details or date. Only include fields you want to change — omitted fields are left as-is. Use search_activities or get_activity first to find the activity_id.",
    {
      activity_id: z.number().describe("Copper activity ID to update"),
      details: z.string().optional().describe("Activity content — meeting notes, action items, summary, etc. Use plain text, not markdown."),
      activity_date: z.number().optional().describe("Unix timestamp for when the activity occurred"),
    },
    async ({ activity_id, details, activity_date }) => {
      const body = {};
      if (details !== undefined) body.details = details;
      if (activity_date !== undefined) body.activity_date = activity_date;

      const result = await copperFetch(`/activities/${activity_id}`, { method: "PUT", body });
      return jsonResult(result);
    }
  );

  // --- Delete Activity ---
  server.tool(
    "delete_activity",
    "Permanently delete an activity from Copper CRM. This cannot be undone. Use search_activities or get_activity first to confirm the activity_id.",
    {
      activity_id: z.number().describe("Copper activity ID to delete"),
    },
    async ({ activity_id }) => {
      const result = await copperFetch(`/activities/${activity_id}`, { method: "DELETE" });
      return jsonResult(result);
    }
  );

  // --- Search Activities ---
  server.tool(
    "search_activities",
    "Search Copper activities (meeting notes, calls, emails logged against contacts). Filter by parent record, activity type, or date range. Returns resolved parent names. Excludes system activities (assignee/status changes) by default.",
    {
      parent_type: z.enum(PARENT_TYPES).optional().describe("Filter by parent entity type"),
      parent_id: z.number().optional().describe("Filter by parent entity ID (requires parent_type)"),
      minimum_activity_date: z.number().optional().describe("Unix timestamp — only activities on or after this date"),
      maximum_activity_date: z.number().optional().describe("Unix timestamp — only activities on or before this date"),
      include_system: z.boolean().optional().describe("Include system activities like assignee/status changes (default: false)"),
      page_size: z.number().optional().describe("Results per page (default 200, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
    },
    async ({ parent_type, parent_id, minimum_activity_date, maximum_activity_date, include_system, page_size, page_number }) => {
      const body = {};
      if (parent_type && parent_id) body.parent = { id: parent_id, type: parent_type };
      if (minimum_activity_date) body.minimum_activity_date = minimum_activity_date;
      if (maximum_activity_date) body.maximum_activity_date = maximum_activity_date;
      body.page_size = page_size || 200;
      body.page_number = page_number || 1;

      const results = await copperFetch("/activities/search", { method: "POST", body });

      // Filter out system activities unless explicitly requested.
      const filtered = include_system
        ? results
        : results.filter((a) => a.type?.category === "user");

      // Resolve parent names (cached per request).
      const nameCache = new Map();
      const activities = await Promise.all(
        filtered.map(async (a) => {
          const pType = a.parent?.type;
          const pId = a.parent?.id;
          const parent_name = pType && pId
            ? await resolveParentName(pType, pId, nameCache)
            : null;

          return {
            id: a.id,
            parent: a.parent,
            parent_name,
            type: a.type,
            user_id: a.user_id,
            details: a.details,
            activity_date: a.activity_date,
            date_created: a.date_created,
            date_modified: a.date_modified,
          };
        })
      );

      return jsonResult(activities);
    }
  );
}

// Smoke helper: pick a "user"-category activity type id (Note is typically id 0).
async function firstUserActivityTypeId(fetch) {
  const types = await fetch("/activity_types");
  return types?.user?.[0]?.id ?? 0;
}

export const smoke = {
  read: [
    { tool: "search_activities", args: { page_size: 1 } },
    async ({ call }) => {
      const list = await call("search_activities", { page_size: 1 });
      if (list && list.length) await call("get_activity", { activity_id: list[0].id });
    },
  ],
  write: [
    // 1. create -> get -> update -> delete, against a throwaway fixture person.
    async ({ call, fetch, stamp }) => {
      const activityTypeId = await firstUserActivityTypeId(fetch);
      const person = await fetch("/people", { method: "POST", body: { name: `zzz_${stamp}` } });
      let activity;
      try {
        activity = await call("create_activity", {
          parent_type: "person",
          parent_id: person.id,
          activity_type_id: activityTypeId,
          details: "zzz smoke",
        });
        await call("get_activity", { activity_id: activity.id });
        await call("update_activity", { activity_id: activity.id, details: "zzz smoke updated" });
      } finally {
        if (activity) await call("delete_activity", { activity_id: activity.id });
        await fetch(`/people/${person.id}`, { method: "DELETE" });
      }
    },
    // 2. bulk_create_activities (2) against a throwaway fixture person -> delete both + person.
    async ({ call, fetch, stamp }) => {
      const activityTypeId = await firstUserActivityTypeId(fetch);
      const person = await fetch("/people", { method: "POST", body: { name: `zzz_${stamp}_bulk` } });
      let created = [];
      try {
        created = await call("bulk_create_activities", {
          activities: [
            { parent_type: "person", parent_id: person.id, activity_type_id: activityTypeId, details: "zzz bulk 1" },
            { parent_type: "person", parent_id: person.id, activity_type_id: activityTypeId, details: "zzz bulk 2" },
          ],
        });
      } finally {
        for (const a of created) await call("delete_activity", { activity_id: a.id });
        await fetch(`/people/${person.id}`, { method: "DELETE" });
      }
    },
  ],
};
