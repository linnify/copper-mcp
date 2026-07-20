import { z } from "zod";
import { copperFetch } from "../copper.js";
import { jsonResult } from "../result.js";

// Leads. https://developer.copper.com/leads/overview.html
// Full parity: get, create, update, delete, bulk_create, bulk_update, upsert (by email and by
// custom field), convert, search, and list-activities — all 11 operations from the resource's
// sub-pages (the overview table's HTTP methods were not trusted; each sub-page was read directly).
//
// Leads differ from People in shape: a lead has a single `email` object (not a plural `emails`
// array) and `company_name` free text (not a `company_id` link) — a lead isn't linked to a real
// Company/Person record until it's converted.

// --- Shared field schemas ---
const emailSchema = z.object({
  email: z.string().describe("Email address"),
  category: z.enum(["work", "personal", "other"]).optional().describe("Email category"),
});

const phoneNumberSchema = z.object({
  number: z.string().describe("Phone number"),
  category: z.enum(["work", "mobile", "home", "other"]).optional().describe("Phone number category"),
});

const socialSchema = z.object({
  url: z.string().describe("Social profile URL"),
  category: z.string().optional().describe("Social network, e.g. facebook, twitter, linkedin"),
});

const websiteSchema = z.object({
  url: z.string().describe("Website URL"),
  category: z.string().optional().describe("Website category, e.g. work, personal, other"),
});

const addressSchema = z.object({
  street: z.string().optional().describe("Street address"),
  city: z.string().optional().describe("City"),
  state: z.string().optional().describe("State or province"),
  postal_code: z.string().optional().describe("Postal/ZIP code"),
  country: z.string().optional().describe("Two-character country code"),
});

const customFieldSchema = z.object({
  custom_field_definition_id: z.number().describe("Custom field definition ID"),
  value: z.any().describe("Value for this custom field (type depends on the field's definition); use null to clear it"),
});

// Fields shared by create_lead, update_lead, bulk_create/update, and the `properties` object of
// both upsert tools. `name` is declared separately per-tool since it's required on create but
// optional on update/upsert.
const leadOptionalFields = {
  email: emailSchema.optional().describe("Primary email address"),
  phone_numbers: z.array(phoneNumberSchema).optional().describe("Phone numbers"),
  socials: z.array(socialSchema).optional().describe("Social profile links"),
  websites: z.array(websiteSchema).optional().describe("Website links"),
  address: addressSchema.optional().describe("Postal address"),
  assignee_id: z.number().optional().describe("Copper user ID to assign this lead to"),
  company_name: z.string().optional().describe("Company name associated with the lead (free text — leads aren't linked to a real Company record until converted)"),
  title: z.string().optional().describe("Job title"),
  customer_source_id: z.number().optional().describe("Customer source ID indicating where the lead came from (see Copper's customer sources)"),
  status_id: z.number().optional().describe("Lead status ID"),
  monetary_value: z.number().optional().describe("Estimated monetary value of the lead"),
  details: z.string().optional().describe("Free-text notes ('About' section)"),
  tags: z.array(z.string()).optional().describe("Tags for categorization (replaces existing tags)"),
  custom_fields: z.array(customFieldSchema).optional().describe("Custom field values"),
};
// Same as leadOptionalFields minus `email` — upsert_lead takes `email` as its own top-level
// (string) match/set parameter instead of the {email, category} object shape.
const { email: _omitEmail, ...leadOptionalFieldsNoEmail } = leadOptionalFields;

const LEAD_FIELD_KEYS = [
  "name", "email", "phone_numbers", "socials", "websites", "address", "assignee_id",
  "company_name", "title", "customer_source_id", "status_id", "monetary_value", "details",
  "tags", "custom_fields",
];

// Build a Copper lead request body from parsed tool args, including only fields the caller
// actually provided — so PUT/POST never clobbers unset fields with `undefined`.
function buildLeadBody(fields) {
  const body = {};
  for (const key of LEAD_FIELD_KEYS) {
    if (fields[key] !== undefined) body[key] = fields[key];
  }
  return body;
}

export function register(server) {
  // --- Get Lead ---
  server.tool(
    "get_lead",
    "Get full details of a Copper lead by its ID. Use search_leads first to find a lead_id.",
    {
      lead_id: z.number().describe("Copper lead ID"),
    },
    async ({ lead_id }) => {
      const lead = await copperFetch(`/leads/${lead_id}`);
      return jsonResult(lead);
    }
  );

  // --- Create Lead ---
  server.tool(
    "create_lead",
    "Create a new lead in Copper CRM. Only 'name' is required; send whichever other fields you have.",
    {
      name: z.string().describe("Lead's name (required)"),
      ...leadOptionalFields,
    },
    async (args) => {
      const body = buildLeadBody(args);
      const result = await copperFetch("/leads", { method: "POST", body });
      return jsonResult(result);
    }
  );

  // --- Bulk Create Leads ---
  server.tool(
    "bulk_create_leads",
    "Create multiple leads in Copper CRM in one request. Each lead only requires 'name'. Keep batches reasonably small — Copper rate-limits bulk endpoints.",
    {
      leads: z
        .array(z.object({ name: z.string().describe("Lead's name (required)"), ...leadOptionalFields }))
        .describe("Array of lead objects to create"),
    },
    async ({ leads }) => {
      const body = { leads: leads.map((l) => buildLeadBody(l)) };
      const result = await copperFetch("/leads/bulk_create", { method: "POST", body });
      return jsonResult(result);
    }
  );

  // --- Update Lead ---
  server.tool(
    "update_lead",
    "Update an existing lead in Copper CRM. Only include fields you want to change — omitted fields are left as-is (send null for a field to explicitly clear it).",
    {
      lead_id: z.number().describe("Copper lead ID to update"),
      name: z.string().optional().describe("Lead's name"),
      ...leadOptionalFields,
    },
    async ({ lead_id, ...fields }) => {
      const body = buildLeadBody(fields);
      const result = await copperFetch(`/leads/${lead_id}`, { method: "PUT", body });
      return jsonResult(result);
    }
  );

  // --- Bulk Update Leads ---
  server.tool(
    "bulk_update_leads",
    "Update multiple leads in Copper CRM in one request. Each item must include 'id' plus the fields to change. Copper caps this at 10 leads per request.",
    {
      leads: z
        .array(
          z.object({
            id: z.number().describe("Copper lead ID to update"),
            name: z.string().optional().describe("Lead's name"),
            ...leadOptionalFields,
          })
        )
        .describe("Array of lead updates (max 10); each needs 'id' plus the changed fields"),
    },
    async ({ leads }) => {
      const body = { leads: leads.map((l) => ({ id: l.id, ...buildLeadBody(l) })) };
      const result = await copperFetch("/leads/bulk_update", { method: "POST", body });
      return jsonResult(result);
    }
  );

  // --- Delete Lead ---
  server.tool(
    "delete_lead",
    "Permanently delete a lead from Copper CRM.",
    {
      lead_id: z.number().describe("Copper lead ID to delete"),
    },
    async ({ lead_id }) => {
      const result = await copperFetch(`/leads/${lead_id}`, { method: "DELETE" });
      return jsonResult(result);
    }
  );

  // --- Upsert Lead (match by email) ---
  server.tool(
    "upsert_lead",
    "Create or update a lead, matching an existing lead by email address: if a lead with this email exists it's updated in place, otherwise a new lead is created. Shares the /leads/upsert endpoint with upsert_lead_by_custom_field — they differ only in match criteria.",
    {
      email: z.string().describe("Email address to match an existing lead by, and to set as the lead's email"),
      email_category: z.enum(["work", "personal", "other"]).optional().describe("Category for the email (default: work)"),
      name: z.string().optional().describe("Lead's name"),
      ...leadOptionalFieldsNoEmail,
    },
    async ({ email, email_category, ...rest }) => {
      const properties = buildLeadBody(rest);
      properties.email = email_category ? { email, category: email_category } : { email };

      const body = { properties, match: { field_name: "email", field_value: email } };
      const result = await copperFetch("/leads/upsert", { method: "PUT", body });
      return jsonResult(result);
    }
  );

  // --- Upsert Lead (match by custom field) ---
  server.tool(
    "upsert_lead_by_custom_field",
    "Create or update a lead, matching an existing lead by a custom field's value: if a lead with that value already exists it's updated in place, otherwise a new lead is created. Shares the /leads/upsert endpoint with upsert_lead — they differ only in match criteria.",
    {
      custom_field_definition_id: z.number().describe("Custom field definition ID to match existing leads on"),
      custom_field_value: z.any().describe("Value to match against, and to set on the upserted lead's custom field"),
      name: z.string().optional().describe("Lead's name"),
      ...leadOptionalFields,
    },
    async ({ custom_field_definition_id, custom_field_value, ...rest }) => {
      const properties = buildLeadBody(rest);
      const body = {
        properties,
        match: { field_name: "custom", field_value: { custom_field_definition_id, value: custom_field_value } },
      };
      const result = await copperFetch("/leads/upsert", { method: "PUT", body });
      return jsonResult(result);
    }
  );

  // --- Convert Lead ---
  // Verified live against the sandbox: converting a lead consumes it (the lead is deleted, GET → 404)
  // and returns { person, company, opportunity? } for the records Copper creates. A person-only
  // convert still auto-creates a company. Write-smoked below (create → convert → delete the created
  // records by the ids in the response).
  server.tool(
    "convert_lead",
    "Convert a lead into a Person (and optionally a Company and/or Opportunity). Copper deletes the source lead once conversion succeeds. Returns the newly created person/company/opportunity records.",
    {
      lead_id: z.number().describe("Copper lead ID to convert"),
      person_name: z.string().optional().describe("Name for the new person (defaults to the lead's own name if omitted)"),
      person_contact_type_id: z.number().optional().describe("Contact type ID for the new person"),
      person_assignee_id: z.number().optional().describe("Assignee user ID for the new person"),
      company_id: z.number().optional().describe("Existing company ID to associate the new person with (mutually exclusive with company_name)"),
      company_name: z.string().optional().describe("Company name to associate/create (pass '' to explicitly create no company); mutually exclusive with company_id"),
      company_exact_match: z.boolean().optional().describe("Require an exact company-name match instead of Copper's fuzzy match"),
      opportunity_name: z.string().optional().describe("Name for a new opportunity to create from this lead (omit to convert without creating an opportunity)"),
      opportunity_pipeline_id: z.number().optional().describe("Pipeline ID for the new opportunity"),
      opportunity_pipeline_stage_id: z.number().optional().describe("Pipeline stage ID (defaults to the pipeline's first stage)"),
      opportunity_monetary_value: z.number().optional().describe("Monetary value for the new opportunity"),
      opportunity_assignee_id: z.number().optional().describe("Assignee user ID for the new opportunity"),
    },
    async ({
      lead_id, person_name, person_contact_type_id, person_assignee_id,
      company_id, company_name, company_exact_match,
      opportunity_name, opportunity_pipeline_id, opportunity_pipeline_stage_id, opportunity_monetary_value, opportunity_assignee_id,
    }) => {
      const details = {};

      const person = {};
      if (person_name !== undefined) person.name = person_name;
      if (person_contact_type_id !== undefined) person.contact_type_id = person_contact_type_id;
      if (person_assignee_id !== undefined) person.assignee_id = person_assignee_id;
      if (Object.keys(person).length) details.person = person;

      const company = {};
      if (company_id !== undefined) company.id = company_id;
      if (company_name !== undefined) company.name = company_name;
      if (company_exact_match !== undefined) company.exact_match = company_exact_match;
      if (Object.keys(company).length) details.company = company;

      const opportunity = {};
      if (opportunity_name !== undefined) opportunity.name = opportunity_name;
      if (opportunity_pipeline_id !== undefined) opportunity.pipeline_id = opportunity_pipeline_id;
      if (opportunity_pipeline_stage_id !== undefined) opportunity.pipeline_stage_id = opportunity_pipeline_stage_id;
      if (opportunity_monetary_value !== undefined) opportunity.monetary_value = opportunity_monetary_value;
      if (opportunity_assignee_id !== undefined) opportunity.assignee_id = opportunity_assignee_id;
      if (Object.keys(opportunity).length) details.opportunity = opportunity;

      const body = Object.keys(details).length ? { details } : {};
      const result = await copperFetch(`/leads/${lead_id}/convert`, { method: "POST", body });
      return jsonResult(result);
    }
  );

  // --- Search Leads ---
  server.tool(
    "search_leads",
    "Search Copper leads by name, contact info, status, assignee, source, location, value, tags, dates, or custom fields. Excludes already-converted leads unless include_converted_leads is set.",
    {
      name: z.string().optional().describe("Full or partial lead name"),
      phone_number: z.string().optional().describe("Phone number to match"),
      emails: z.string().optional().describe("Email address to match"),
      assignee_ids: z.array(z.number()).optional().describe("Filter by assignee user IDs (-2 for unassigned)"),
      status_ids: z.array(z.number()).optional().describe("Filter by lead status IDs"),
      customer_source_ids: z.array(z.number()).optional().describe("Filter by customer source IDs (-2 for none)"),
      city: z.string().optional().describe("City filter"),
      state: z.string().optional().describe("State/province filter"),
      postal_code: z.string().optional().describe("Postal/ZIP code filter"),
      country: z.string().optional().describe("Two-character country code filter"),
      tags: z.array(z.string()).optional().describe("Tags to filter by"),
      tags_option: z.string().optional().describe("Tag match option — Copper documents 'ANY'; omit for the default match behavior"),
      minimum_monetary_value: z.number().optional().describe("Minimum monetary value"),
      maximum_monetary_value: z.number().optional().describe("Maximum monetary value"),
      minimum_created_date: z.number().optional().describe("Unix timestamp — only leads created on/after this date (Copper caps this at 2147483648)"),
      maximum_created_date: z.number().optional().describe("Unix timestamp — only leads created on/before this date (Copper caps this at 2147483648)"),
      minimum_modified_date: z.number().optional().describe("Unix timestamp — only leads modified on/after this date (Copper caps this at 2147483648)"),
      maximum_modified_date: z.number().optional().describe("Unix timestamp — only leads modified on/before this date (Copper caps this at 2147483648)"),
      // NOTE: passing `allow_empty` alone (no `value`/`option`) has been observed to trigger a
      // Copper-side HTTP 500 for at least String-type fields, despite being a documented filter
      // shape — pair it with `value` or `option` if you hit that.
      custom_fields: z
        .array(
          z.object({
            custom_field_definition_id: z.number().describe("Custom field definition ID"),
            value: z.any().optional().describe("Exact value to match"),
            option: z.string().optional().describe("Match option, e.g. 'ANY' for multi-select fields"),
            allow_empty: z.boolean().optional().describe("Include leads where this field is empty (Copper has been observed to 500 when this is the ONLY key set for a field — pair it with value/option)"),
            minimum_value: z.any().optional().describe("Minimum value (numeric/date fields)"),
            maximum_value: z.any().optional().describe("Maximum value (numeric/date fields)"),
          })
        )
        .optional()
        .describe("Custom field filters"),
      include_converted_leads: z.boolean().optional().describe("Include leads that have already been converted (default: false)"),
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
      sort_by: z
        .enum(["name", "company_name", "title", "value", "email", "phone", "date_modified", "date_created", "city", "state", "country", "zip", "inactive_days", "socials"])
        .optional()
        .describe("Field to sort by"),
      sort_direction: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
    },
    async ({
      name, phone_number, emails, assignee_ids, status_ids, customer_source_ids,
      city, state, postal_code, country, tags, tags_option,
      minimum_monetary_value, maximum_monetary_value,
      minimum_created_date, maximum_created_date, minimum_modified_date, maximum_modified_date,
      custom_fields, include_converted_leads, page_size, page_number, sort_by, sort_direction,
    }) => {
      const body = {};
      if (name !== undefined) body.name = name;
      if (phone_number !== undefined) body.phone_number = phone_number;
      if (emails !== undefined) body.emails = emails;
      if (assignee_ids !== undefined) body.assignee_ids = assignee_ids;
      if (status_ids !== undefined) body.status_ids = status_ids;
      if (customer_source_ids !== undefined) body.customer_source_ids = customer_source_ids;
      if (city !== undefined) body.city = city;
      if (state !== undefined) body.state = state;
      if (postal_code !== undefined) body.postal_code = postal_code;
      if (country !== undefined) body.country = country;
      if (tags !== undefined) body.tags = tags_option ? { option: tags_option, value: tags } : { value: tags };
      if (minimum_monetary_value !== undefined) body.minimum_monetary_value = minimum_monetary_value;
      if (maximum_monetary_value !== undefined) body.maximum_monetary_value = maximum_monetary_value;
      if (minimum_created_date !== undefined) body.minimum_created_date = minimum_created_date;
      if (maximum_created_date !== undefined) body.maximum_created_date = maximum_created_date;
      if (minimum_modified_date !== undefined) body.minimum_modified_date = minimum_modified_date;
      if (maximum_modified_date !== undefined) body.maximum_modified_date = maximum_modified_date;
      if (custom_fields !== undefined) body.custom_fields = custom_fields;
      if (include_converted_leads !== undefined) body.include_converted_leads = include_converted_leads;
      body.page_size = page_size || 20;
      body.page_number = page_number || 1;
      if (sort_by) body.sort_by = sort_by;
      if (sort_direction) body.sort_direction = sort_direction;

      const results = await copperFetch("/leads/search", { method: "POST", body });
      const leads = results.map((l) => ({
        id: l.id,
        name: l.name,
        company_name: l.company_name,
        email: l.email,
        phone_numbers: l.phone_numbers,
        status: l.status,
        status_id: l.status_id,
        assignee_id: l.assignee_id,
        customer_source_id: l.customer_source_id,
        monetary_value: l.monetary_value,
        city: l.address?.city,
        state: l.address?.state,
        country: l.address?.country,
        tags: l.tags,
        date_created: l.date_created,
        date_modified: l.date_modified,
        converted_contact_id: l.converted_contact_id,
        converted_opportunity_id: l.converted_opportunity_id,
        converted_at: l.converted_at,
      }));
      return jsonResult(leads);
    }
  );

  // --- List Lead Activities ---
  server.tool(
    "list_lead_activities",
    "List activities (calls, notes, emails, status changes, etc.) logged against a Copper lead. Excludes system activities (assignee/status changes) by default. Use search_leads or get_lead first to find a lead_id.",
    {
      lead_id: z.number().describe("Copper lead ID"),
      include_system: z.boolean().optional().describe("Include system activities like assignee/status changes (default: false)"),
    },
    async ({ lead_id, include_system }) => {
      const results = await copperFetch(`/leads/${lead_id}/activities`, { method: "POST", body: {} });
      const filtered = include_system ? results : results.filter((a) => a.type?.category === "user");
      const activities = filtered.map((a) => ({
        id: a.id,
        type: a.type,
        user_id: a.user_id,
        details: a.details,
        activity_date: a.activity_date,
        old_value: a.old_value,
        new_value: a.new_value,
        date_created: a.date_created,
        date_modified: a.date_modified,
      }));
      return jsonResult(activities);
    }
  );
}

// Smoke checks. Run: npm run smoke -- --only leads --write
export const smoke = {
  read: [
    { tool: "search_leads", args: { page_size: 1 } },
    async ({ call }) => {
      const list = await call("search_leads", { page_size: 1 });
      if (list && list.length) await call("get_lead", { lead_id: list[0].id });
    },
    async ({ call }) => {
      const list = await call("search_leads", { page_size: 1 });
      if (list && list.length) await call("list_lead_activities", { lead_id: list[0].id });
    },
  ],
  write: [
    // 1. create -> update -> delete
    async ({ call, stamp }) => {
      const lead = await call("create_lead", { name: `zzz_${stamp}` });
      try {
        await call("update_lead", { lead_id: lead.id, details: "smoke test" });
      } finally {
        await call("delete_lead", { lead_id: lead.id });
      }
    },
    // 2. upsert_lead by email -> delete
    async ({ call, stamp }) => {
      const email = `zzz_${stamp}@example.com`;
      const lead = await call("upsert_lead", { email, name: `zzz_${stamp}` });
      try {
        // The upsert call succeeding (HTTP 200) is the assertion; nothing else to verify.
      } finally {
        await call("delete_lead", { lead_id: lead.id });
      }
    },
    // 3. bulk_create_leads (2) -> delete both
    async ({ call, stamp }) => {
      const leads = await call("bulk_create_leads", {
        leads: [{ name: `zzz_${stamp}_a` }, { name: `zzz_${stamp}_b` }],
      });
      try {
        // Bulk-create succeeding (HTTP 200) with 2 records back is the assertion.
      } finally {
        for (const l of leads) await call("delete_lead", { lead_id: l.id });
      }
    },
    // 4. convert_lead: create a lead, convert it (Copper consumes the lead and creates a person +
    //    company), then delete the created records by the ids in the convert response. delete_person/
    //    delete_company live in other modules (not registered under `--only leads`), so cleanup uses
    //    raw ctx.fetch. The lead itself is consumed by a successful convert.
    async ({ call, fetch, stamp }) => {
      const lead = await call("create_lead", { name: `zzz_${stamp}_cv` });
      let r;
      try {
        r = await call("convert_lead", { lead_id: lead.id, person_name: `zzz_${stamp}_cv` });
      } finally {
        if (r?.person?.id) await fetch(`/people/${r.person.id}`, { method: "DELETE" });
        if (r?.company?.id) await fetch(`/companies/${r.company.id}`, { method: "DELETE" });
        if (r?.opportunity?.id) await fetch(`/opportunities/${r.opportunity.id}`, { method: "DELETE" });
        if (!r) await fetch(`/leads/${lead.id}`, { method: "DELETE" }).catch(() => {}); // only if convert failed
      }
    },
  ],
};
