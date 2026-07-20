import { z } from "zod";
import { copperFetch } from "../copper.js";
import { jsonResult } from "../result.js";

// Opportunities (deals). https://developer.copper.com/opportunities/overview.html
// Full parity: search, get, create, update, delete, and bulk_create — the 6 operations Copper
// documents for this resource. Unlike People/Leads there is NO bulk_update and NO
// fetch_by_email sub-page for Opportunities. Each operation's own sub-page was read directly
// (not the overview's property table) — see the doc notes below for where they disagreed.
//
// Doc quirks worth flagging (see report):
// - `close_date` (create/update/get) is documented as a plain date STRING in "MM/DD/YYYY or
//   DD/MM/YYYY format" — NOT a Unix timestamp, unlike virtually every other Copper date field.
//   The *search* filters `minimum_close_date`/`maximum_close_date`, by contrast, ARE documented
//   as Unix timestamps. Both are implemented per their own sub-page.
// - The create sub-page's own field table states only `name` is required. In practice Copper
//   accounts commonly also expect a primary contact and/or pipeline/stage to accept the create
//   (account-dependent, not universal) — none of those are hard-required in this schema; the
//   write smoke check discovers a pipeline/stage + a throwaway contact and passes them to be safe.
// - `status` (Open/Won/Lost/Abandoned) and `win_probability` don't appear in the single
//   create-page's field table but DO appear in the bulk_create sub-page's example body, and both
//   are core documented properties of the resource — included here on create/update/bulk_create
//   so a deal can be marked Won/Lost via the API (pair `status: "Lost"` with `loss_reason_id`).
// - Search's `tags` filter is a wrapped `{ option, value }` shape (like Leads), not a plain array.

const customFieldValueSchema = z.object({
  custom_field_definition_id: z.number().describe("ID of the Custom Field Definition (see your Copper account's custom field settings)"),
  value: z.any().describe("Value to set (string, number, option id, or timestamp depending on the field's type)"),
});

// Filter-by-value shape, used by search_opportunities (custom_fields[]).
const customFieldFilterSchema = z.object({
  custom_field_definition_id: z.number().describe("Custom Field Definition ID to filter on"),
  value: z.any().optional().describe("Exact value to match (or array of option ids for multi-select fields)"),
  option: z.string().optional().describe("Match option for multi-select fields, e.g. 'ANY'"),
  allow_empty: z.boolean().optional().describe("Also include opportunities where this field is empty"),
  minimum_value: z.any().optional().describe("Minimum value to match (numeric/date range fields)"),
  maximum_value: z.any().optional().describe("Maximum value to match (numeric/date range fields)"),
});

// Fields shared by create_opportunity / update_opportunity / bulk_create_opportunities.
// `name` is declared separately per-tool (required on create, optional on update).
const opportunityOptionalFields = {
  primary_contact_id: z.number().optional().describe("Copper person ID of the primary contact for this opportunity. Copper accounts commonly require this (or a pipeline) to create successfully — find one with search_people, or create_person first."),
  company_id: z.number().optional().describe("Copper company ID to associate as the primary company"),
  company_name: z.string().optional().describe("Company name to associate with this opportunity (free text — Copper may auto-link to an existing company of this name)"),
  assignee_id: z.number().optional().describe("Copper user ID to assign as owner of this opportunity"),
  customer_source_id: z.number().optional().describe("Customer source ID indicating how this opportunity originated (see your Copper account's customer sources)"),
  loss_reason_id: z.number().optional().describe("Loss reason ID — relevant when status is 'Lost'"),
  pipeline_id: z.number().optional().describe("Pipeline ID this opportunity belongs to (defaults to the account's default pipeline if omitted)"),
  pipeline_stage_id: z.number().optional().describe("Pipeline stage ID within the pipeline (defaults to the pipeline's first stage if omitted)"),
  monetary_value: z.number().optional().describe("Monetary value of the deal"),
  close_date: z.string().optional().describe("Expected close date as a date STRING in MM/DD/YYYY or DD/MM/YYYY format (Copper documents this field as a formatted date string, not a Unix timestamp)"),
  details: z.string().optional().describe("Free-text description of the opportunity"),
  priority: z.enum(["None", "Low", "Medium", "High"]).optional().describe("Priority of the opportunity"),
  status: z.enum(["Open", "Won", "Lost", "Abandoned"]).optional().describe("Status of the opportunity — set to 'Won' or 'Lost' to close the deal via the API (pair 'Lost' with loss_reason_id)"),
  win_probability: z.number().optional().describe("Probability of winning this deal, 0-100"),
  tags: z.array(z.string()).optional().describe("Tags for categorization (replaces existing tags)"),
  custom_fields: z.array(customFieldValueSchema).optional().describe("Custom field values to set"),
};

const OPPORTUNITY_FIELD_KEYS = ["name", ...Object.keys(opportunityOptionalFields)];

// Only copy fields the caller actually provided, so PUT/POST bodies never clobber unset fields.
function buildOpportunityBody(input) {
  const body = {};
  for (const key of OPPORTUNITY_FIELD_KEYS) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  return body;
}

const SORT_BY_VALUES = [
  "assignee", "company_name", "customer_source_id", "date_created", "date_modified",
  "inactive_days", "interaction_count", "last_interaction", "monetary_unit", "monetary_value",
  "name", "primary_contact", "priority", "stage", "status",
];

export function register(server) {
  // --- Search Opportunities ---
  server.tool(
    "search_opportunities",
    "Search Copper opportunities (deals) by name, company, primary contact, pipeline/stage, status, priority, assignee, value, dates, tags, or custom fields. Returns deal name, value, status, and pipeline stage.",
    {
      ids: z.array(z.number()).optional().describe("Specific Copper opportunity IDs to fetch"),
      name: z.string().optional().describe("Opportunity name to search"),
      company_ids: z.array(z.number()).optional().describe("Filter by associated company IDs"),
      person_ids: z.array(z.number()).optional().describe("Filter by primary contact (person) IDs — sent to Copper as primary_contact_ids"),
      assignee_ids: z.array(z.number()).optional().describe("Filter by owning user IDs (-2 means unassigned)"),
      status_ids: z.array(z.number()).optional().describe("Filter by status: 0=Open, 1=Won, 2=Lost, 3=Abandoned"),
      pipeline_ids: z.array(z.number()).optional().describe("Filter by pipeline IDs"),
      pipeline_stage_ids: z.array(z.number()).optional().describe("Filter by pipeline stage IDs"),
      priority_ids: z.array(z.number()).optional().describe("Filter by priority IDs"),
      customer_source_ids: z.array(z.number()).optional().describe("Filter by customer source IDs (-2 means none)"),
      loss_reason_ids: z.array(z.number()).optional().describe("Filter by loss reason IDs (-2 means none)"),
      tags: z.array(z.string()).optional().describe("Filter by tags (matches opportunities with these tags)"),
      tags_option: z.string().optional().describe("Tag match option — Copper documents 'ANY'; omit for the default match behavior"),
      followed: z.number().optional().describe("1 = only opportunities you follow, 2 = only ones you don't follow"),
      minimum_monetary_value: z.number().optional().describe("Minimum deal value"),
      maximum_monetary_value: z.number().optional().describe("Maximum deal value"),
      minimum_interaction_count: z.number().optional().describe("Minimum number of interactions"),
      maximum_interaction_count: z.number().optional().describe("Maximum number of interactions"),
      minimum_close_date: z.number().optional().describe("Unix timestamp — earliest expected close date"),
      maximum_close_date: z.number().optional().describe("Unix timestamp — latest expected close date"),
      minimum_interaction_date: z.number().optional().describe("Unix timestamp — earliest last-interaction date"),
      maximum_interaction_date: z.number().optional().describe("Unix timestamp — latest last-interaction date"),
      minimum_stage_change_date: z.number().optional().describe("Unix timestamp — earliest pipeline-stage change date"),
      maximum_stage_change_date: z.number().optional().describe("Unix timestamp — latest pipeline-stage change date"),
      minimum_created_date: z.number().optional().describe("Unix timestamp — earliest creation date"),
      maximum_created_date: z.number().optional().describe("Unix timestamp — latest creation date"),
      minimum_modified_date: z.number().optional().describe("Unix timestamp — earliest modification date"),
      maximum_modified_date: z.number().optional().describe("Unix timestamp — latest modification date"),
      custom_fields: z.array(customFieldFilterSchema).optional().describe("Filter by custom field values"),
      sort_by: z.enum(SORT_BY_VALUES).optional().describe("Field to sort by (default: name)"),
      sort_direction: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: asc)"),
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
    },
    async (args) => {
      const {
        ids, name, company_ids, person_ids, assignee_ids, status_ids, pipeline_ids, pipeline_stage_ids,
        priority_ids, customer_source_ids, loss_reason_ids, tags, tags_option, followed,
        minimum_monetary_value, maximum_monetary_value, minimum_interaction_count, maximum_interaction_count,
        minimum_close_date, maximum_close_date, minimum_interaction_date, maximum_interaction_date,
        minimum_stage_change_date, maximum_stage_change_date, minimum_created_date, maximum_created_date,
        minimum_modified_date, maximum_modified_date, custom_fields, sort_by, sort_direction,
        page_size, page_number,
      } = args;
      const body = {};
      if (ids !== undefined) body.ids = ids;
      if (name !== undefined) body.name = name;
      if (company_ids !== undefined) body.company_ids = company_ids;
      if (person_ids !== undefined) body.primary_contact_ids = person_ids;
      if (assignee_ids !== undefined) body.assignee_ids = assignee_ids;
      if (status_ids !== undefined) body.status_ids = status_ids;
      if (pipeline_ids !== undefined) body.pipeline_ids = pipeline_ids;
      if (pipeline_stage_ids !== undefined) body.pipeline_stage_ids = pipeline_stage_ids;
      if (priority_ids !== undefined) body.priority_ids = priority_ids;
      if (customer_source_ids !== undefined) body.customer_source_ids = customer_source_ids;
      if (loss_reason_ids !== undefined) body.loss_reason_ids = loss_reason_ids;
      if (tags !== undefined) body.tags = tags_option ? { option: tags_option, value: tags } : { value: tags };
      if (followed !== undefined) body.followed = followed;
      if (minimum_monetary_value !== undefined) body.minimum_monetary_value = minimum_monetary_value;
      if (maximum_monetary_value !== undefined) body.maximum_monetary_value = maximum_monetary_value;
      if (minimum_interaction_count !== undefined) body.minimum_interaction_count = minimum_interaction_count;
      if (maximum_interaction_count !== undefined) body.maximum_interaction_count = maximum_interaction_count;
      if (minimum_close_date !== undefined) body.minimum_close_date = minimum_close_date;
      if (maximum_close_date !== undefined) body.maximum_close_date = maximum_close_date;
      if (minimum_interaction_date !== undefined) body.minimum_interaction_date = minimum_interaction_date;
      if (maximum_interaction_date !== undefined) body.maximum_interaction_date = maximum_interaction_date;
      if (minimum_stage_change_date !== undefined) body.minimum_stage_change_date = minimum_stage_change_date;
      if (maximum_stage_change_date !== undefined) body.maximum_stage_change_date = maximum_stage_change_date;
      if (minimum_created_date !== undefined) body.minimum_created_date = minimum_created_date;
      if (maximum_created_date !== undefined) body.maximum_created_date = maximum_created_date;
      if (minimum_modified_date !== undefined) body.minimum_modified_date = minimum_modified_date;
      if (maximum_modified_date !== undefined) body.maximum_modified_date = maximum_modified_date;
      if (custom_fields !== undefined) body.custom_fields = custom_fields;
      if (sort_by !== undefined) body.sort_by = sort_by;
      if (sort_direction !== undefined) body.sort_direction = sort_direction;
      body.page_size = page_size || 20;
      body.page_number = page_number || 1;

      const results = await copperFetch("/opportunities/search", { method: "POST", body });
      const opps = results.map((o) => ({
        id: o.id,
        name: o.name,
        company_id: o.company_id,
        company_name: o.company_name,
        primary_contact_id: o.primary_contact_id,
        assignee_id: o.assignee_id,
        monetary_value: o.monetary_value,
        status: o.status,
        priority: o.priority,
        pipeline_id: o.pipeline_id,
        pipeline_stage_id: o.pipeline_stage_id,
        close_date: o.close_date,
        win_probability: o.win_probability,
        tags: o.tags,
      }));
      return jsonResult(opps);
    }
  );

  // --- Get Opportunity ---
  server.tool(
    "get_opportunity",
    "Get full details of a Copper opportunity (deal) by its ID. Use search_opportunities first to find an opportunity_id.",
    {
      opportunity_id: z.number().describe("Copper opportunity ID"),
    },
    async ({ opportunity_id }) => {
      const opportunity = await copperFetch(`/opportunities/${opportunity_id}`);
      return jsonResult(opportunity);
    }
  );

  // --- Create Opportunity ---
  server.tool(
    "create_opportunity",
    "Create a new opportunity (deal) in Copper CRM. Copper's API only requires `name`, but many accounts also expect a primary_contact_id and/or pipeline_id/pipeline_stage_id to accept the create — supply those (find a contact with search_people) if a bare create is rejected.",
    {
      name: z.string().describe("Opportunity name (required)"),
      ...opportunityOptionalFields,
    },
    async (args) => {
      const body = buildOpportunityBody(args);
      const result = await copperFetch("/opportunities", { method: "POST", body });
      return jsonResult(result);
    }
  );

  // --- Bulk Create Opportunities ---
  server.tool(
    "bulk_create_opportunities",
    "Create up to 10 opportunities (deals) in Copper in a single request. Each entry accepts the same fields as create_opportunity — `name` is required for each.",
    {
      opportunities: z.array(z.object({ name: z.string().describe("Opportunity name (required)"), ...opportunityOptionalFields }))
        .min(1)
        .max(10)
        .describe("Opportunities to create (1-10 per request — Copper's bulk-create limit)"),
    },
    async ({ opportunities }) => {
      const payload = opportunities.map((o) => buildOpportunityBody(o));
      const result = await copperFetch("/opportunities/bulk_create", { method: "POST", body: { opportunities: payload } });
      return jsonResult(result);
    }
  );

  // --- Update Opportunity ---
  server.tool(
    "update_opportunity",
    "Update an existing opportunity (deal) in Copper CRM. Only include fields you want to change — omitted fields are left as-is (send null to explicitly clear a field). Set status to 'Won' or 'Lost' to close the deal via the API (pair 'Lost' with loss_reason_id).",
    {
      opportunity_id: z.number().describe("Copper opportunity ID to update"),
      name: z.string().optional().describe("Opportunity name"),
      ...opportunityOptionalFields,
    },
    async ({ opportunity_id, ...fields }) => {
      const body = buildOpportunityBody(fields);
      const result = await copperFetch(`/opportunities/${opportunity_id}`, { method: "PUT", body });
      return jsonResult(result);
    }
  );

  // --- Delete Opportunity ---
  server.tool(
    "delete_opportunity",
    "Permanently delete an opportunity (deal) from Copper CRM. This cannot be undone. Use search_opportunities or get_opportunity first to confirm the opportunity_id.",
    {
      opportunity_id: z.number().describe("Copper opportunity ID to delete"),
    },
    async ({ opportunity_id }) => {
      const result = await copperFetch(`/opportunities/${opportunity_id}`, { method: "DELETE" });
      return jsonResult(result);
    }
  );
}

// Discover a pipeline + its first stage for the write smoke checks below — some accounts require
// one on create. Returns {} (no pipeline/stage fields) if the sandbox has none configured.
async function discoverPipelineFixture(fetch) {
  const pipelines = await fetch("/pipelines");
  const pipeline = pipelines?.[0];
  const stage = pipeline?.stages?.[0];
  const fields = {};
  if (pipeline) fields.pipeline_id = pipeline.id;
  if (stage) fields.pipeline_stage_id = stage.id;
  return fields;
}

// Smoke checks. Run: npm run smoke -- --only opportunities --write
export const smoke = {
  read: [
    { tool: "search_opportunities", args: { page_size: 1 } },
    async ({ call }) => {
      const list = await call("search_opportunities", { page_size: 1 });
      if (list && list.length) await call("get_opportunity", { opportunity_id: list[0].id });
    },
  ],
  write: [
    // 1. create -> update -> delete, with a throwaway primary contact + discovered pipeline/stage
    //    (Copper may require either depending on account config — see the doc-quirk notes above).
    async ({ call, fetch, stamp }) => {
      const pipelineFields = await discoverPipelineFixture(fetch);
      const person = await fetch("/people", { method: "POST", body: { name: `zzz_${stamp}_contact` } });

      let opportunity;
      try {
        opportunity = await call("create_opportunity", {
          name: `zzz_${stamp}`,
          primary_contact_id: person.id,
          ...pipelineFields,
        });
        await call("update_opportunity", { opportunity_id: opportunity.id, details: "smoke test", priority: "Low" });
      } finally {
        if (opportunity?.id) await call("delete_opportunity", { opportunity_id: opportunity.id });
        await fetch(`/people/${person.id}`, { method: "DELETE" });
      }
    },
    // 2. bulk_create_opportunities (2) -> delete both, reusing the same kind of fixtures.
    async ({ call, fetch, stamp }) => {
      const pipelineFields = await discoverPipelineFixture(fetch);
      const person = await fetch("/people", { method: "POST", body: { name: `zzz_${stamp}_bulk_contact` } });

      let created = [];
      try {
        created = await call("bulk_create_opportunities", {
          opportunities: [
            { name: `zzz_${stamp}_bulk1`, primary_contact_id: person.id, ...pipelineFields },
            { name: `zzz_${stamp}_bulk2`, primary_contact_id: person.id, ...pipelineFields },
          ],
        });
      } finally {
        for (const o of created) await call("delete_opportunity", { opportunity_id: o.id });
        await fetch(`/people/${person.id}`, { method: "DELETE" });
      }
    },
  ],
};
