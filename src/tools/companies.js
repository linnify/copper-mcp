import { z } from "zod";
import { copperFetch } from "../copper.js";
import { jsonResult } from "../result.js";

// Companies. https://developer.copper.com/companies/overview.html
// Full parity: search, get, create, update, delete, bulk_create, bulk_update, and per-company
// activity listing — all 8 operations from the resource's sub-pages (the overview table's HTTP
// methods were not trusted; each sub-page was read directly).
//
// Notes on doc inconsistencies found while implementing (see report for details):
// - The singular create/update sub-pages document assignee_id, contact_type_id and
//   primary_contact_id; the bulk_create/bulk_update sub-pages' example field lists omit them
//   (mirroring the create-vs-update gap already seen in people.js/leads.js). Since the GET
//   response schema confirms these fields live on the company resource itself, one shared
//   writable-fields object is used for create/update/bulk_create/bulk_update, same as
//   personWritableFields in people.js.
// - socials/websites don't get a documented per-item shape on the Companies sub-pages; the
//   {url, category} shape used here matches every other entity (People, Leads) in this API.
// - The search sub-page documents minimum/maximum_created_date but NOT a modified-date filter
//   (unlike Leads' search, which has both) — omitted rather than guessing at an undocumented field.
// - custom_fields search-filter shape (custom_field_definition_id/value/minimum_value/
//   maximum_value/allow_empty) comes from Copper's generic "search entity by custom field" doc,
//   which explicitly states it applies to Companies too.

// --- Shared field schemas (reused across create/update/bulk/search tools) ---
const phoneSchema = z.object({
  number: z.string().describe("Phone number"),
  category: z.string().optional().describe("Category, e.g. work, mobile, home, other"),
});
const socialSchema = z.object({
  url: z.string().describe("Social profile URL"),
  category: z.string().optional().describe("Category, e.g. twitter, linkedin, facebook, other"),
});
const websiteSchema = z.object({
  url: z.string().describe("Website URL"),
  category: z.string().optional().describe("Category, e.g. work, personal, other"),
});
const addressSchema = z.object({
  street: z.string().optional().describe("Street address"),
  city: z.string().optional().describe("City"),
  state: z.string().optional().describe("State or province"),
  postal_code: z.string().optional().describe("Postal or ZIP code"),
  country: z.string().optional().describe("Country name"),
});
// Set-a-value shape, used by create/update/bulk (custom_fields[].value).
const customFieldValueSchema = z.object({
  custom_field_definition_id: z.number().describe("ID of the Custom Field Definition (see your Copper account's custom field settings)"),
  value: z.any().describe("Value to set (string, number, option id, or Unix timestamp depending on the field's type)"),
});
// Filter-by-value shape, used by search_companies (custom_fields[]). Per Copper's generic
// "Search Entity (Leads, People, etc) by Custom Field" doc, which applies across all entities.
const customFieldFilterSchema = z.object({
  custom_field_definition_id: z.number().describe("ID of the Custom Field Definition to filter on"),
  value: z.any().optional().describe("Exact value to match (e.g. an array of option ids for dropdowns, boolean for checkboxes)"),
  minimum_value: z.any().optional().describe("Minimum value to match (Date/Percentage/Currency/Number range fields)"),
  maximum_value: z.any().optional().describe("Maximum value to match (Date/Percentage/Currency/Number range fields)"),
  allow_empty: z.boolean().optional().describe("Also include companies where this field is empty (dropdown/multi-select fields only)"),
});

// Fields shared by create_company / update_company / bulk_create_companies / bulk_update_companies.
// `name` is declared separately per-tool since it's required on create but optional on update.
const companyOptionalFields = {
  address: addressSchema.optional().describe("Postal address"),
  assignee_id: z.number().optional().describe("Copper user ID to assign as owner of this company"),
  contact_type_id: z.number().optional().describe("Contact type ID configured in your Copper account (e.g. Customer, Vendor)"),
  details: z.string().optional().describe("About/details text (visible at top of company page in Copper UI)"),
  email_domain: z.string().optional().describe("Company's email domain, e.g. example.com"),
  phone_numbers: z.array(phoneSchema).optional().describe("Phone numbers"),
  socials: z.array(socialSchema).optional().describe("Social profile links (e.g. Twitter, LinkedIn)"),
  websites: z.array(websiteSchema).optional().describe("Website links"),
  primary_contact_id: z.number().optional().describe("Copper person ID to set as this company's primary contact"),
  tags: z.array(z.string()).optional().describe("Tags for categorization (replaces existing tags)"),
  custom_fields: z.array(customFieldValueSchema).optional().describe("Custom field values to set"),
};

const COMPANY_FIELD_KEYS = ["name", ...Object.keys(companyOptionalFields)];

// Only copy fields the caller actually provided, so PUT/POST bodies never clobber unset fields.
function buildCompanyBody(input) {
  const body = {};
  for (const key of COMPANY_FIELD_KEYS) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  return body;
}

const SORT_BY_VALUES = [
  "name", "phone", "contact", "contact_first_name", "contact_last_name",
  "date_modified", "date_created", "email_domain", "city", "state", "country", "zip",
  "assignee", "contact_group", "last_interaction", "interaction_count", "primary_website", "socials",
];

export function register(server) {
  // --- Search Companies ---
  server.tool(
    "search_companies",
    "Search Copper companies by name, phone, location, tags, assignee, contact type, or other filters. Returns matching company records with IDs for use in get_company, update_company, delete_company, list_company_activities, etc.",
    {
      ids: z.array(z.number()).optional().describe("Specific Copper company IDs to fetch"),
      name: z.string().optional().describe("Full name or partial name to search"),
      phone_number: z.string().optional().describe("Phone number to match"),
      email_domains: z.array(z.string()).optional().describe("Email domains to match"),
      contact_type_ids: z.array(z.number()).optional().describe("Filter by contact type IDs"),
      assignee_ids: z.array(z.number()).optional().describe("Filter by owning user IDs (-2 means unassigned)"),
      city: z.string().optional().describe("Filter by city"),
      state: z.string().optional().describe("Filter by state/province"),
      postal_code: z.string().optional().describe("Filter by postal/zip code"),
      country: z.string().optional().describe("Filter by two-character country code"),
      tags: z.array(z.string()).optional().describe("Filter by tags (matches companies with any of these tags)"),
      socials: z.array(z.string()).optional().describe("Filter by social profile URLs"),
      followed: z.number().optional().describe("1 = only companies you follow, 2 = only companies you don't follow"),
      age: z.number().optional().describe("Maximum age in seconds since the company was created"),
      minimum_interaction_count: z.number().optional().describe("Minimum number of interactions"),
      maximum_interaction_count: z.number().optional().describe("Maximum number of interactions"),
      minimum_interaction_date: z.number().optional().describe("Unix timestamp — earliest last-interaction date"),
      maximum_interaction_date: z.number().optional().describe("Unix timestamp — latest last-interaction date"),
      minimum_created_date: z.number().optional().describe("Unix timestamp — earliest creation date"),
      maximum_created_date: z.number().optional().describe("Unix timestamp — latest creation date"),
      custom_fields: z.array(customFieldFilterSchema).optional().describe("Filter by custom field values"),
      sort_by: z.enum(SORT_BY_VALUES).optional().describe("Field to sort by (default: date_modified)"),
      sort_direction: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: asc)"),
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
    },
    async (args) => {
      const {
        ids, name, phone_number, email_domains, contact_type_ids, assignee_ids,
        city, state, postal_code, country, tags, socials, followed, age,
        minimum_interaction_count, maximum_interaction_count, minimum_interaction_date, maximum_interaction_date,
        minimum_created_date, maximum_created_date, custom_fields, sort_by, sort_direction,
        page_size, page_number,
      } = args;
      const body = {};
      if (ids !== undefined) body.ids = ids;
      if (name !== undefined) body.name = name;
      if (phone_number !== undefined) body.phone_number = phone_number;
      if (email_domains !== undefined) body.email_domains = email_domains;
      if (contact_type_ids !== undefined) body.contact_type_ids = contact_type_ids;
      if (assignee_ids !== undefined) body.assignee_ids = assignee_ids;
      if (city !== undefined) body.city = city;
      if (state !== undefined) body.state = state;
      if (postal_code !== undefined) body.postal_code = postal_code;
      if (country !== undefined) body.country = country;
      if (tags !== undefined) body.tags = tags;
      if (socials !== undefined) body.socials = socials;
      if (followed !== undefined) body.followed = followed;
      if (age !== undefined) body.age = age;
      if (minimum_interaction_count !== undefined) body.minimum_interaction_count = minimum_interaction_count;
      if (maximum_interaction_count !== undefined) body.maximum_interaction_count = maximum_interaction_count;
      if (minimum_interaction_date !== undefined) body.minimum_interaction_date = minimum_interaction_date;
      if (maximum_interaction_date !== undefined) body.maximum_interaction_date = maximum_interaction_date;
      if (minimum_created_date !== undefined) body.minimum_created_date = minimum_created_date;
      if (maximum_created_date !== undefined) body.maximum_created_date = maximum_created_date;
      if (custom_fields !== undefined) body.custom_fields = custom_fields;
      if (sort_by !== undefined) body.sort_by = sort_by;
      if (sort_direction !== undefined) body.sort_direction = sort_direction;
      body.page_size = page_size || 20;
      body.page_number = page_number || 1;

      const results = await copperFetch("/companies/search", { method: "POST", body });
      const companies = results.map((c) => ({
        id: c.id,
        name: c.name,
        email_domain: c.email_domain,
        phone_numbers: c.phone_numbers,
        websites: c.websites,
        address: c.address,
        assignee_id: c.assignee_id,
        contact_type_id: c.contact_type_id,
        primary_contact_id: c.primary_contact_id,
        tags: c.tags,
      }));
      return jsonResult(companies);
    }
  );

  // --- Get Company ---
  server.tool(
    "get_company",
    "Get full details of a Copper company by its ID. Use search_companies first to find a company_id.",
    {
      company_id: z.number().describe("Copper company ID"),
    },
    async ({ company_id }) => {
      const company = await copperFetch(`/companies/${company_id}`);
      return jsonResult(company);
    }
  );

  // --- Create Company ---
  server.tool(
    "create_company",
    "Create a new company in Copper CRM. Only `name` is required; send whichever other fields you have.",
    {
      name: z.string().describe("Company name (required)"),
      ...companyOptionalFields,
    },
    async (args) => {
      const body = buildCompanyBody(args);
      const result = await copperFetch("/companies", { method: "POST", body });
      return jsonResult(result);
    }
  );

  // --- Bulk Create Companies ---
  server.tool(
    "bulk_create_companies",
    "Create up to 10 companies in Copper in a single request. Each entry accepts the same fields as create_company — `name` is required for each.",
    {
      companies: z.array(z.object({ name: z.string().describe("Company name (required)"), ...companyOptionalFields }))
        .min(1)
        .max(10)
        .describe("Companies to create (1-10 per request — Copper's bulk-create limit)"),
    },
    async ({ companies }) => {
      const payload = companies.map((c) => buildCompanyBody(c));
      const result = await copperFetch("/companies/bulk_create", { method: "POST", body: { companies: payload } });
      return jsonResult(result);
    }
  );

  // --- Update Company ---
  server.tool(
    "update_company",
    "Update an existing company in Copper CRM. Only include fields you want to change — omitted fields are left as-is. The 'details' field is the 'About' section visible at the top of the company page.",
    {
      company_id: z.number().describe("Copper company ID to update"),
      name: z.string().optional().describe("Company name"),
      ...companyOptionalFields,
    },
    async ({ company_id, ...fields }) => {
      const body = buildCompanyBody(fields);
      const result = await copperFetch(`/companies/${company_id}`, { method: "PUT", body });
      return jsonResult(result);
    }
  );

  // --- Bulk Update Companies ---
  server.tool(
    "bulk_update_companies",
    "Update up to 10 companies in Copper in a single request. Each entry must include the company's `id` (from search_companies or get_company) plus only the fields to change.",
    {
      companies: z.array(z.object({
        id: z.number().describe("Copper company ID to update"),
        name: z.string().optional().describe("Company name"),
        ...companyOptionalFields,
      }))
        .min(1)
        .max(10)
        .describe("Companies to update (1-10 per request — Copper's bulk-update limit)"),
    },
    async ({ companies }) => {
      const payload = companies.map((c) => ({ id: c.id, ...buildCompanyBody(c) }));
      const result = await copperFetch("/companies/bulk_update", { method: "POST", body: { companies: payload } });
      return jsonResult(result);
    }
  );

  // --- Delete Company ---
  server.tool(
    "delete_company",
    "Permanently delete a company from Copper CRM. This cannot be undone. Use search_companies or get_company first to confirm the company_id.",
    {
      company_id: z.number().describe("Copper company ID to delete"),
    },
    async ({ company_id }) => {
      const result = await copperFetch(`/companies/${company_id}`, { method: "DELETE" });
      return jsonResult(result);
    }
  );

  // --- List Company Activities ---
  server.tool(
    "list_company_activities",
    "List activities (notes, calls, emails) logged against a specific Copper company. Use search_companies or get_company first to find the company_id. Excludes system activities (assignee/status changes) by default.",
    {
      company_id: z.number().describe("Copper company ID"),
      include_system: z.boolean().optional().describe("Include system activities like assignee/status changes (default: false)"),
    },
    async ({ company_id, include_system }) => {
      const results = await copperFetch(`/companies/${company_id}/activities`, { method: "POST", body: {} });

      const filtered = include_system ? results : results.filter((a) => a.type?.category === "user");
      const activities = filtered.map((a) => ({
        id: a.id,
        parent: a.parent,
        type: a.type,
        user_id: a.user_id,
        details: a.details,
        activity_date: a.activity_date,
        date_created: a.date_created,
        date_modified: a.date_modified,
      }));
      return jsonResult(activities);
    }
  );
}

// Smoke checks. Run: npm run smoke -- --only companies --write
export const smoke = {
  read: [
    { tool: "search_companies", args: { page_size: 1 } },
    async ({ call }) => {
      const list = await call("search_companies", { page_size: 1 });
      if (list && list.length) await call("get_company", { company_id: list[0].id });
    },
    async ({ call }) => {
      const list = await call("search_companies", { page_size: 1 });
      if (list && list.length) await call("list_company_activities", { company_id: list[0].id });
    },
  ],
  write: [
    // 1. create -> update -> delete
    async ({ call, stamp }) => {
      const company = await call("create_company", { name: `zzz_${stamp}` });
      try {
        await call("update_company", { company_id: company.id, details: "Smoke Test", tags: ["smoke"] });
      } finally {
        await call("delete_company", { company_id: company.id });
      }
    },
    // 2. bulk_create_companies (2) -> bulk_update_companies -> delete both
    async ({ call, stamp }) => {
      const created = await call("bulk_create_companies", {
        companies: [
          { name: `zzz_${stamp}_bulk1` },
          { name: `zzz_${stamp}_bulk2` },
        ],
      });
      try {
        await call("bulk_update_companies", {
          companies: created.map((c) => ({ id: c.id, details: "Smoke Bulk" })),
        });
      } finally {
        for (const c of created) {
          await call("delete_company", { company_id: c.id });
        }
      }
    },
  ],
};
