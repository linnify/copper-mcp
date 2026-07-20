import { z } from "zod";
import { copperFetch } from "../copper.js";
import { jsonResult } from "../result.js";

// Reference / enum lookups used to populate dropdowns and resolve IDs referenced by other
// entities (people, companies, leads, opportunities, activities). All are simple top-level GETs
// with no pagination and no request body — full parity with Copper's reference-data endpoints.
// Docs: https://developer.copper.com/opportunities/overview.html (pipelines, pipeline stages,
// customer sources, loss reasons), https://developer.copper.com/leads/overview.html (lead
// statuses), https://developer.copper.com/people/overview.html (contact types),
// https://developer.copper.com/activities/overview.html (activity types).
export function register(server) {
  // --- List Activity Types ---
  server.tool(
    "list_activity_types",
    "List all available activity types in Copper (e.g., Note, Meeting, Phone Call). Returns activity_type_id values needed for create_activity.",
    {},
    async () => {
      const result = await copperFetch("/activity_types");
      return jsonResult(result);
    }
  );

  // --- List Pipelines ---
  server.tool(
    "list_pipelines",
    "List all opportunity pipelines configured in Copper, each with its nested stages. Returns pipeline_id and stage id/name/win_probability values needed for pipeline_id / pipeline_stage_id on create_opportunity, update_opportunity, and search_opportunities. Use list_pipeline_stages_by_pipeline if you only need one pipeline's stages.",
    {},
    async () => {
      const result = await copperFetch("/pipelines");
      return jsonResult(result);
    }
  );

  // --- List Pipeline Stages ---
  server.tool(
    "list_pipeline_stages",
    "List every pipeline stage across all pipelines in the Copper account (each includes its parent pipeline_id). Returns pipeline_stage_id values needed for pipeline_stage_id on create_opportunity, update_opportunity, and search_opportunities. Use list_pipeline_stages_by_pipeline to filter to a single pipeline.",
    {},
    async () => {
      const result = await copperFetch("/pipeline_stages");
      return jsonResult(result);
    }
  );

  // --- List Pipeline Stages by Pipeline ---
  server.tool(
    "list_pipeline_stages_by_pipeline",
    "List only the stages belonging to one specific pipeline. Use list_pipelines first to find the pipeline_id.",
    {
      pipeline_id: z.number().describe("Pipeline ID to list stages for (from list_pipelines)"),
    },
    async ({ pipeline_id }) => {
      const result = await copperFetch(`/pipeline_stages/pipeline/${pipeline_id}`);
      return jsonResult(result);
    }
  );

  // --- List Customer Sources ---
  server.tool(
    "list_customer_sources",
    "List the customer source options configured in Copper (e.g., Email, Cold Call, Advertising) describing where a lead or opportunity originated. Returns customer_source_id values used by create_lead, search_leads, create_opportunity, and search_opportunities.",
    {},
    async () => {
      const result = await copperFetch("/customer_sources");
      return jsonResult(result);
    }
  );

  // --- List Loss Reasons ---
  server.tool(
    "list_loss_reasons",
    "List the loss reason options configured in Copper (e.g., Price, Features, Competitor). Returns loss_reason_id values used with update_opportunity when setting status to 'Lost'.",
    {},
    async () => {
      const result = await copperFetch("/loss_reasons");
      return jsonResult(result);
    }
  );

  // --- List Lead Statuses ---
  server.tool(
    "list_lead_statuses",
    "List the lead status options configured in Copper (e.g., New, Open, Unqualified, Junk), in pipeline order. Returns status_id values used by create_lead, update_lead, and search_leads. Requires the Leads feature to be enabled on the account.",
    {},
    async () => {
      const result = await copperFetch("/lead_statuses");
      return jsonResult(result);
    }
  );

  // --- List Contact Types ---
  server.tool(
    "list_contact_types",
    "List the contact type options configured in Copper (e.g., Potential Customer, Current Customer). Returns contact_type_id values used by create_person, update_person, and search_people.",
    {},
    async () => {
      const result = await copperFetch("/contact_types");
      return jsonResult(result);
    }
  );
}

export const smoke = {
  read: [
    { tool: "list_activity_types", args: {} },
    { tool: "list_pipelines", args: {} },
    { tool: "list_pipeline_stages", args: {} },
    { tool: "list_customer_sources", args: {} },
    { tool: "list_loss_reasons", args: {} },
    { tool: "list_lead_statuses", args: {} },
    { tool: "list_contact_types", args: {} },
    async ({ call }) => {
      const pipelines = await call("list_pipelines", {});
      const pipeline_id = pipelines?.[0]?.id;
      if (pipeline_id) await call("list_pipeline_stages_by_pipeline", { pipeline_id });
    },
  ],
  write: [],
};
