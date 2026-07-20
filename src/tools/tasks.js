import { z } from "zod";
import { copperFetch } from "../copper.js";
import { jsonResult } from "../result.js";

// Tasks. https://developer.copper.com/tasks/overview.html
// Full parity per the coordinator's scope: get, create, update, delete, search — the 5 operations
// actually linked from the overview page (its "Linked Operations" list has exactly these 5 — no
// bulk_create/bulk_update/upsert sub-pages exist for Tasks, unlike People/Leads).
//
// Field name note: a Task's link to another record is `related_resource: { id, type }` (confirmed
// verbatim on the get/create sub-pages) — NOT `parent`, unlike Activities (`parent: { type, id }`).
// Exposed here as two flat params (related_resource_type/related_resource_id), mirroring how
// activities.js exposes its parent link as parent_type/parent_id rather than a nested object.

const customFieldValueSchema = z.object({
  custom_field_definition_id: z.number().describe("ID of the Custom Field Definition (see your Copper account's custom field settings)"),
  value: z.any().describe("Value to set (string, number, option id, boolean, or Unix timestamp depending on the field's type); use null to clear it"),
});

// Types a Task's related_resource can point to. Only "project" ever appears in a doc example;
// the rest are inferred from Copper's general parent-type convention (see CLAUDE.md / the `parent`
// enum in activities.js) since no Tasks sub-page enumerates the full set. "task" is deliberately
// excluded — a task relating to another task isn't a documented Copper concept.
const RELATED_RESOURCE_TYPES = ["lead", "person", "company", "opportunity", "project"];

// Fields shared by create_task / update_task. `name` is declared per-tool (required on create,
// optional on update), so it's not included here.
const taskOptionalFields = {
  assignee_id: z.number().optional().describe("Copper user ID to assign as owner of this task"),
  due_date: z.number().optional().describe("Unix timestamp for the task's due date"),
  reminder_date: z.number().optional().describe("Unix timestamp for when a reminder should fire"),
  // See report: sub-pages only ever show "None" in examples; the (untrusted) overview table also
  // lists "Low"/"Medium"/"High" but no operation sub-page confirms the full set. Left as a free
  // string rather than a restrictive enum so a valid Copper value is never rejected by this schema.
  priority: z.string().optional().describe('Priority level, e.g. "None", "Low", "Medium", "High" — only "None" is confirmed by a doc example; send whatever value your Copper account uses'),
  status: z.enum(["Open", "Completed"]).optional().describe("Task status"),
  details: z.string().optional().describe("Task description/notes"),
  tags: z.array(z.string()).optional().describe("Tags for categorization (replaces existing tags)"),
  custom_fields: z.array(customFieldValueSchema).optional().describe("Custom field values to set"),
  related_resource_type: z.enum(RELATED_RESOURCE_TYPES).optional().describe("Type of record this task is linked to — provide together with related_resource_id"),
  related_resource_id: z.number().optional().describe("ID of the record this task is linked to — provide together with related_resource_type"),
};

const TASK_FIELD_KEYS = ["assignee_id", "due_date", "reminder_date", "priority", "status", "details", "tags", "custom_fields"];

// Build a Copper task request body from parsed tool args, including only fields the caller
// actually provided — so PUT/POST never clobbers unset fields with `undefined`.
function buildTaskBody({ name, related_resource_type, related_resource_id, ...rest }) {
  const body = {};
  if (name !== undefined) body.name = name;
  for (const key of TASK_FIELD_KEYS) {
    if (rest[key] !== undefined) body[key] = rest[key];
  }
  if (related_resource_type !== undefined || related_resource_id !== undefined) {
    if (related_resource_type === undefined || related_resource_id === undefined) {
      throw new Error("Provide both related_resource_type and related_resource_id together, or neither.");
    }
    body.related_resource = { type: related_resource_type, id: related_resource_id };
  }
  return body;
}

const TASK_SORT_BY_VALUES = [
  "name", "assigned_to", "related_to", "status", "priority",
  "due_date", "reminder_date", "completed_date", "date_created", "date_modified",
];

export function register(server) {
  // --- Get Task ---
  server.tool(
    "get_task",
    "Get full details of a Copper task by its ID. Use search_tasks first to find a task_id.",
    {
      task_id: z.number().describe("Copper task ID"),
    },
    async ({ task_id }) => {
      const task = await copperFetch(`/tasks/${task_id}`);
      return jsonResult(task);
    }
  );

  // --- Create Task ---
  server.tool(
    "create_task",
    "Create a new task in Copper CRM. Only `name` is required. Link it to a lead/person/company/opportunity/project with related_resource_type + related_resource_id.",
    {
      name: z.string().describe("Task name/title (required)"),
      ...taskOptionalFields,
    },
    async (args) => {
      const body = buildTaskBody(args);
      const result = await copperFetch("/tasks", { method: "POST", body });
      return jsonResult(result);
    }
  );

  // --- Update Task ---
  server.tool(
    "update_task",
    "Update an existing Copper task. Only include fields you want to change — omitted fields are left as-is. Use search_tasks or get_task first to confirm the task_id.",
    {
      task_id: z.number().describe("Copper task ID to update"),
      name: z.string().optional().describe("Task name/title"),
      ...taskOptionalFields,
    },
    async ({ task_id, ...fields }) => {
      const body = buildTaskBody(fields);
      const result = await copperFetch(`/tasks/${task_id}`, { method: "PUT", body });
      return jsonResult(result);
    }
  );

  // --- Delete Task ---
  server.tool(
    "delete_task",
    "Permanently delete a task from Copper CRM. This cannot be undone. Use search_tasks or get_task first to confirm the task_id.",
    {
      task_id: z.number().describe("Copper task ID to delete"),
    },
    async ({ task_id }) => {
      const result = await copperFetch(`/tasks/${task_id}`, { method: "DELETE" });
      return jsonResult(result);
    }
  );

  // --- Search Tasks ---
  server.tool(
    "search_tasks",
    "Search Copper tasks by assignee, related opportunity/project, status, tags, due date, or other filters. Returns matching task records with IDs for use in get_task, update_task, delete_task.",
    {
      ids: z.array(z.number()).optional().describe("Specific Copper task IDs to fetch"),
      assignee_ids: z.array(z.number()).optional().describe("Filter by owning user IDs (-2 for tasks with no owner)"),
      opportunity_ids: z.array(z.number()).optional().describe("Filter by related opportunity IDs"),
      project_ids: z.array(z.number()).optional().describe("Filter by related project IDs (-2 for tasks with no project)"),
      statuses: z.array(z.enum(["Open", "Completed"])).optional().describe("Filter by task status"),
      tags: z.array(z.string()).optional().describe("Filter by tags (matches tasks with any of these tags)"),
      followed: z.number().optional().describe("1 = only tasks you follow, 2 = only tasks you don't follow"),
      minimum_due_date: z.number().optional().describe("Unix timestamp — earliest due date"),
      maximum_due_date: z.number().optional().describe("Unix timestamp — latest due date"),
      minimum_created_date: z.number().optional().describe("Unix timestamp — earliest creation date"),
      maximum_created_date: z.number().optional().describe("Unix timestamp — latest creation date"),
      minimum_modified_date: z.number().optional().describe("Unix timestamp — earliest last-modified date"),
      maximum_modified_date: z.number().optional().describe("Unix timestamp — latest last-modified date"),
      sort_by: z.enum(TASK_SORT_BY_VALUES).optional().describe("Field to sort by (default: due_date)"),
      sort_direction: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: asc)"),
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
    },
    async (args) => {
      const {
        ids, assignee_ids, opportunity_ids, project_ids, statuses, tags, followed,
        minimum_due_date, maximum_due_date, minimum_created_date, maximum_created_date,
        minimum_modified_date, maximum_modified_date, sort_by, sort_direction,
        page_size, page_number,
      } = args;
      const body = {};
      if (ids !== undefined) body.ids = ids;
      if (assignee_ids !== undefined) body.assignee_ids = assignee_ids;
      if (opportunity_ids !== undefined) body.opportunity_ids = opportunity_ids;
      if (project_ids !== undefined) body.project_ids = project_ids;
      if (statuses !== undefined) body.statuses = statuses;
      if (tags !== undefined) body.tags = tags;
      if (followed !== undefined) body.followed = followed;
      if (minimum_due_date !== undefined) body.minimum_due_date = minimum_due_date;
      if (maximum_due_date !== undefined) body.maximum_due_date = maximum_due_date;
      if (minimum_created_date !== undefined) body.minimum_created_date = minimum_created_date;
      if (maximum_created_date !== undefined) body.maximum_created_date = maximum_created_date;
      if (minimum_modified_date !== undefined) body.minimum_modified_date = minimum_modified_date;
      if (maximum_modified_date !== undefined) body.maximum_modified_date = maximum_modified_date;
      if (sort_by !== undefined) body.sort_by = sort_by;
      if (sort_direction !== undefined) body.sort_direction = sort_direction;
      body.page_size = page_size || 20;
      body.page_number = page_number || 1;

      const results = await copperFetch("/tasks/search", { method: "POST", body });
      const tasks = results.map((t) => ({
        id: t.id,
        name: t.name,
        related_resource: t.related_resource,
        assignee_id: t.assignee_id,
        due_date: t.due_date,
        reminder_date: t.reminder_date,
        completed_date: t.completed_date,
        priority: t.priority,
        status: t.status,
        tags: t.tags,
        date_created: t.date_created,
        date_modified: t.date_modified,
      }));
      return jsonResult(tasks);
    }
  );
}

// Smoke checks. Run: npm run smoke -- --only tasks --write
export const smoke = {
  read: [
    { tool: "search_tasks", args: { page_size: 1 } },
    async ({ call }) => {
      const list = await call("search_tasks", { page_size: 1 });
      if (list && list.length) await call("get_task", { task_id: list[0].id });
    },
  ],
  write: [
    async ({ call, stamp }) => {
      const task = await call("create_task", { name: `zzz_${stamp}` });
      try {
        await call("update_task", { task_id: task.id, status: "Completed" });
      } finally {
        await call("delete_task", { task_id: task.id });
      }
    },
  ],
};
