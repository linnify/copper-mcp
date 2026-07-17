import { z } from "zod";
import { copperFetch } from "../copper.js";
import { jsonResult } from "../result.js";

// Projects. https://developer.copper.com/projects/overview.html
// Full parity: get, create, update, delete, search — all 5 operations this resource has (no
// bulk/upsert/convert, unlike Leads/People). Each sub-page was read directly (not the overview
// table, which the builder guide warns can show the wrong verb):
//   GET    /projects/{id}    - fetch-a-project-by-id.html
//   POST   /projects         - create-a-new-project.html
//   PUT    /projects/{id}    - update-a-project.html
//   DELETE /projects/{id}    - delete-a-project.html
//   POST   /projects/search  - list-projects-search.html

// --- Shared field schemas ---
const customFieldValueSchema = z.object({
  custom_field_definition_id: z.number().describe("ID of the Custom Field Definition (see your Copper account's custom field settings)"),
  value: z.any().describe("Value to set (string, number, option id, or Unix timestamp depending on the field's type); use null to clear it"),
});

// Doc quote (create/update sub-pages): "The primary related resource for the Project" — an
// object of { id, type }. The type enum isn't constrained anywhere in the docs (unlike the
// parent-type list CLAUDE.md gives for activities), so this is left as a free-form string rather
// than guessing a zod enum that might reject a valid value — see report for this ambiguity.
const relatedResourceSchema = z.object({
  id: z.number().describe("ID of the related record"),
  type: z.string().describe("Type of the related record this project is attached to, e.g. \"person\", \"company\", \"opportunity\", or \"lead\""),
});

// Fields shared by create_project / update_project. `name` is declared separately per-tool since
// it's required on create but optional on update.
const projectOptionalFields = {
  assignee_id: z.number().optional().describe("Copper user ID to assign as owner of this project"),
  status: z.enum(["Open", "Completed"]).optional().describe("Project status (default on create: Open)"),
  details: z.string().optional().describe("Project description/details"),
  tags: z.array(z.string()).optional().describe("Tags for categorization (replaces existing tags)"),
  custom_fields: z.array(customFieldValueSchema).optional().describe("Custom field values to set"),
  related_resource: relatedResourceSchema.optional().describe("Primary related record this project is attached to (e.g. the company, person, or opportunity it's for)"),
};

const PROJECT_FIELD_KEYS = ["name", "assignee_id", "status", "details", "tags", "custom_fields", "related_resource"];

// Only copy fields the caller actually provided, so PUT/POST bodies never clobber unset fields.
function buildProjectFields(input) {
  const body = {};
  for (const key of PROJECT_FIELD_KEYS) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  return body;
}

const SORT_BY_VALUES = ["name", "assigned_to", "related_to", "status", "date_modified", "date_created"];

export function register(server) {
  // --- Get Project ---
  server.tool(
    "get_project",
    "Get full details of a Copper project by its ID. Use search_projects first to find a project_id.",
    {
      project_id: z.number().describe("Copper project ID"),
    },
    async ({ project_id }) => {
      const project = await copperFetch(`/projects/${project_id}`);
      return jsonResult(project);
    }
  );

  // --- Create Project ---
  server.tool(
    "create_project",
    "Create a new project in Copper CRM. Only 'name' is required; send whichever other fields you have.",
    {
      name: z.string().describe("Project name (required)"),
      ...projectOptionalFields,
    },
    async (args) => {
      const body = buildProjectFields(args);
      const result = await copperFetch("/projects", { method: "POST", body });
      return jsonResult(result);
    }
  );

  // --- Update Project ---
  server.tool(
    "update_project",
    "Update an existing Copper project. Only include fields you want to change — omitted fields are left as-is.",
    {
      project_id: z.number().describe("Copper project ID to update"),
      name: z.string().optional().describe("Project name"),
      ...projectOptionalFields,
    },
    async ({ project_id, ...fields }) => {
      const body = buildProjectFields(fields);
      const result = await copperFetch(`/projects/${project_id}`, { method: "PUT", body });
      return jsonResult(result);
    }
  );

  // --- Delete Project ---
  server.tool(
    "delete_project",
    "Permanently delete a project from Copper CRM. This cannot be undone. Use search_projects or get_project first to confirm the project_id.",
    {
      project_id: z.number().describe("Copper project ID to delete"),
    },
    async ({ project_id }) => {
      const result = await copperFetch(`/projects/${project_id}`, { method: "DELETE" });
      return jsonResult(result);
    }
  );

  // --- Search Projects ---
  server.tool(
    "search_projects",
    "Search Copper projects by name, assignee, status, tags, followed state, or creation/modification dates. Returns matching project records with IDs for use in get_project, update_project, delete_project.",
    {
      ids: z.array(z.number()).optional().describe("Specific Copper project IDs to fetch"),
      name: z.string().optional().describe("Full name of the project to search for"),
      assignee_ids: z.array(z.number()).optional().describe("Filter by owning user IDs (-2 means unassigned)"),
      status_ids: z.array(z.number()).optional().describe("Filter by project status IDs"),
      tags: z.array(z.string()).optional().describe("Filter by tags (matches projects with any of these tags)"),
      followed: z.number().optional().describe("1 = only projects you follow, 2 = only projects you don't follow"),
      minimum_created_date: z.number().optional().describe("Unix timestamp — earliest creation date"),
      maximum_created_date: z.number().optional().describe("Unix timestamp — latest creation date"),
      minimum_modified_date: z.number().optional().describe("Unix timestamp — earliest modification date"),
      maximum_modified_date: z.number().optional().describe("Unix timestamp — latest modification date"),
      sort_by: z.enum(SORT_BY_VALUES).optional().describe("Field to sort by (default: name)"),
      sort_direction: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: asc)"),
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
    },
    async (args) => {
      const {
        ids, name, assignee_ids, status_ids, tags, followed,
        minimum_created_date, maximum_created_date, minimum_modified_date, maximum_modified_date,
        sort_by, sort_direction, page_size, page_number,
      } = args;
      const body = {};
      if (ids !== undefined) body.ids = ids;
      if (name !== undefined) body.name = name;
      if (assignee_ids !== undefined) body.assignee_ids = assignee_ids;
      if (status_ids !== undefined) body.status_ids = status_ids;
      if (tags !== undefined) body.tags = tags;
      if (followed !== undefined) body.followed = followed;
      if (minimum_created_date !== undefined) body.minimum_created_date = minimum_created_date;
      if (maximum_created_date !== undefined) body.maximum_created_date = maximum_created_date;
      if (minimum_modified_date !== undefined) body.minimum_modified_date = minimum_modified_date;
      if (maximum_modified_date !== undefined) body.maximum_modified_date = maximum_modified_date;
      if (sort_by !== undefined) body.sort_by = sort_by;
      if (sort_direction !== undefined) body.sort_direction = sort_direction;
      body.page_size = page_size || 20;
      body.page_number = page_number || 1;

      const results = await copperFetch("/projects/search", { method: "POST", body });
      const projects = results.map((p) => ({
        id: p.id,
        name: p.name,
        related_resource: p.related_resource,
        assignee_id: p.assignee_id,
        status: p.status,
        tags: p.tags,
        date_created: p.date_created,
        date_modified: p.date_modified,
      }));
      return jsonResult(projects);
    }
  );
}

// Smoke checks. Run: npm run smoke -- --only projects --write
export const smoke = {
  read: [
    { tool: "search_projects", args: { page_size: 1 } },
    async ({ call }) => {
      const list = await call("search_projects", { page_size: 1 });
      if (list && list.length) await call("get_project", { project_id: list[0].id });
    },
  ],
  write: [
    async ({ call, stamp }) => {
      const project = await call("create_project", { name: `zzz_${stamp}` });
      try {
        await call("update_project", { project_id: project.id, status: "Completed", details: "smoke test" });
      } finally {
        await call("delete_project", { project_id: project.id });
      }
    },
  ],
};
