import { z } from "zod";
import { copperFetch } from "../copper.js";
import { jsonResult } from "../result.js";

// People (contacts). https://developer.copper.com/people/overview.html
// Full parity: search, get (by id / by email), create, update, delete, bulk create/update,
// and per-person activity listing.

// --- Shared field schemas (reused across create/update/bulk tools) ---
const emailSchema = z.object({
  email: z.string().describe("Email address"),
  category: z.string().optional().describe("Category, e.g. work, personal, other"),
});
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
// Filter-by-value shape, used by search_people (custom_fields[]).
const customFieldFilterSchema = z.object({
  custom_field_definition_id: z.number().describe("ID of the Custom Field Definition to filter on"),
  value: z.any().optional().describe("Exact value to match"),
  minimum_value: z.any().optional().describe("Minimum value to match (numeric/date range fields)"),
  maximum_value: z.any().optional().describe("Maximum value to match (numeric/date range fields)"),
  option: z.any().optional().describe("Dropdown option id(s) to match"),
  allow_empty: z.boolean().optional().describe("Also include people where this field is empty"),
});

// Fields shared by create_person / update_person / bulk_create_people / bulk_update_people.
const personWritableFields = {
  name: z.string().optional().describe("Full name. For create_person, provide this or both first_name and last_name — Copper requires a name."),
  first_name: z.string().optional().describe("First name (combined with last_name to build `name` on create if `name` isn't given)"),
  last_name: z.string().optional().describe("Last name (combined with first_name to build `name` on create if `name` isn't given)"),
  title: z.string().optional().describe("Job title"),
  details: z.string().optional().describe("About/details text (visible at top of contact page in Copper UI)"),
  company_name: z.string().optional().describe("Company name (Copper auto-links to an existing company or creates a new one)"),
  company_id: z.number().optional().describe("Copper company ID to associate with this person"),
  contact_type_id: z.number().optional().describe("Contact type ID configured in your Copper account (e.g. Customer, Potential Customer)"),
  assignee_id: z.number().optional().describe("Copper user ID to assign as owner of this person"),
  emails: z.array(emailSchema).optional().describe("Email addresses"),
  phone_numbers: z.array(phoneSchema).optional().describe("Phone numbers"),
  socials: z.array(socialSchema).optional().describe("Social profile links (e.g. Twitter, LinkedIn)"),
  websites: z.array(websiteSchema).optional().describe("Website links"),
  address: addressSchema.optional().describe("Postal address"),
  tags: z.array(z.string()).optional().describe("Tags for categorization (replaces existing tags)"),
  custom_fields: z.array(customFieldValueSchema).optional().describe("Custom field values to set"),
};

const PERSON_FIELD_KEYS = Object.keys(personWritableFields);

// Only copy fields the caller actually provided, so PUT/POST bodies never clobber unset fields.
function buildPersonFields(input) {
  const body = {};
  for (const key of PERSON_FIELD_KEYS) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  return body;
}

// Copper requires a non-empty `name` on create; derive it from first/last if not given directly.
function resolveFullName({ name, first_name, last_name }) {
  return name || [first_name, last_name].filter(Boolean).join(" ");
}

const SORT_BY_VALUES = [
  "first_name", "name", "title", "email", "phone",
  "date_modified", "date_created", "city", "state", "country", "zip", "socials",
];

export function register(server) {
  // --- Search People ---
  server.tool(
    "search_people",
    "Search Copper contacts by name, email, phone, location, tags, or other filters. Returns matching person records with IDs for use in get_person, update_person, delete_person, create_activity, etc.",
    {
      ids: z.array(z.number()).optional().describe("Specific Copper person IDs to fetch"),
      name: z.string().optional().describe("Full name or partial name to search"),
      emails: z.array(z.string()).optional().describe("Email addresses to match"),
      phone_number: z.string().optional().describe("Phone number to match"),
      contact_type_ids: z.array(z.number()).optional().describe("Filter by contact type IDs"),
      assignee_ids: z.array(z.number()).optional().describe("Filter by owning user IDs (-2 means unassigned)"),
      company_ids: z.array(z.number()).optional().describe("Filter by associated company IDs (-2 means no company)"),
      opportunity_ids: z.array(z.number()).optional().describe("Filter by associated opportunity IDs"),
      city: z.string().optional().describe("Filter by city"),
      state: z.string().optional().describe("Filter by state/province"),
      postal_code: z.string().optional().describe("Filter by postal/zip code"),
      country: z.string().optional().describe("Filter by two-character country code"),
      tags: z.array(z.string()).optional().describe("Filter by tags (matches people with any of these tags)"),
      socials: z.array(z.string()).optional().describe("Filter by social profile URLs"),
      followed: z.number().optional().describe("1 = only people you follow, 2 = only people you don't follow"),
      age: z.number().optional().describe("Maximum age in seconds since the person was created"),
      minimum_interaction_count: z.number().optional().describe("Minimum number of interactions"),
      maximum_interaction_count: z.number().optional().describe("Maximum number of interactions"),
      minimum_interaction_date: z.number().optional().describe("Unix timestamp — earliest last-interaction date"),
      maximum_interaction_date: z.number().optional().describe("Unix timestamp — latest last-interaction date"),
      minimum_created_date: z.number().optional().describe("Unix timestamp — earliest creation date"),
      maximum_created_date: z.number().optional().describe("Unix timestamp — latest creation date"),
      custom_fields: z.array(customFieldFilterSchema).optional().describe("Filter by custom field values"),
      sort_by: z.enum(SORT_BY_VALUES).optional().describe("Field to sort by (default: first_name)"),
      sort_direction: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: asc)"),
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
    },
    async (args) => {
      const {
        ids, name, emails, phone_number, contact_type_ids, assignee_ids, company_ids, opportunity_ids,
        city, state, postal_code, country, tags, socials, followed, age,
        minimum_interaction_count, maximum_interaction_count, minimum_interaction_date, maximum_interaction_date,
        minimum_created_date, maximum_created_date, custom_fields, sort_by, sort_direction,
        page_size, page_number,
      } = args;
      const body = {};
      if (ids !== undefined) body.ids = ids;
      if (name !== undefined) body.name = name;
      if (emails !== undefined) body.emails = emails;
      if (phone_number !== undefined) body.phone_number = phone_number;
      if (contact_type_ids !== undefined) body.contact_type_ids = contact_type_ids;
      if (assignee_ids !== undefined) body.assignee_ids = assignee_ids;
      if (company_ids !== undefined) body.company_ids = company_ids;
      if (opportunity_ids !== undefined) body.opportunity_ids = opportunity_ids;
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

      const results = await copperFetch("/people/search", { method: "POST", body });
      const people = results.map((p) => ({
        id: p.id,
        name: p.name,
        first_name: p.first_name,
        last_name: p.last_name,
        emails: p.emails,
        phone_numbers: p.phone_numbers,
        company_id: p.company_id,
        company_name: p.company_name,
        title: p.title,
        contact_type_id: p.contact_type_id,
        assignee_id: p.assignee_id,
        tags: p.tags,
      }));
      return jsonResult(people);
    }
  );

  // --- Get Person ---
  server.tool(
    "get_person",
    "Get full details of a Copper contact by their ID.",
    {
      person_id: z.number().describe("Copper person ID"),
    },
    async ({ person_id }) => {
      const person = await copperFetch(`/people/${person_id}`);
      return jsonResult(person);
    }
  );

  // --- Get Person by Email ---
  server.tool(
    "get_person_by_email",
    "Look up a Copper person by exact email address and return the full record. Use search_people if you don't have an exact email. Errors if no person matches.",
    {
      email: z.string().describe("Exact email address to look up"),
    },
    async ({ email }) => {
      const person = await copperFetch("/people/fetch_by_email", { method: "POST", body: { email } });
      return jsonResult(person);
    }
  );

  // --- Create Person ---
  server.tool(
    "create_person",
    "Create a new person (contact) in Copper CRM. Provide `name`, or both `first_name` and `last_name`.",
    { ...personWritableFields },
    async (args) => {
      const fullName = resolveFullName(args);
      if (!fullName) throw new Error("Provide `name`, or both `first_name` and `last_name`.");
      const body = buildPersonFields({ ...args, name: fullName });

      const result = await copperFetch("/people", { method: "POST", body });
      return jsonResult(result);
    }
  );

  // --- Bulk Create People ---
  server.tool(
    "bulk_create_people",
    "Create up to 10 people in Copper in a single request. Each entry accepts the same fields as create_person — provide `name`, or both `first_name` and `last_name`, for each.",
    {
      people: z.array(z.object({ ...personWritableFields }))
        .min(1)
        .max(10)
        .describe("People to create (1-10 per request — Copper's bulk-create limit)"),
    },
    async ({ people }) => {
      const payload = people.map((p) => {
        const fullName = resolveFullName(p);
        if (!fullName) throw new Error("Each person needs `name`, or both `first_name` and `last_name`.");
        return buildPersonFields({ ...p, name: fullName });
      });

      const result = await copperFetch("/people/bulk_create", { method: "POST", body: { people: payload } });
      return jsonResult(result);
    }
  );

  // --- Update Person ---
  server.tool(
    "update_person",
    "Update an existing person (contact) in Copper CRM. Only include fields you want to change — omitted fields are left as-is. The 'details' field is the 'About' section visible at the top of the contact page.",
    {
      person_id: z.number().describe("Copper person ID to update"),
      ...personWritableFields,
    },
    async (args) => {
      const { person_id } = args;
      const body = buildPersonFields(args);

      const result = await copperFetch(`/people/${person_id}`, { method: "PUT", body });
      return jsonResult(result);
    }
  );

  // --- Bulk Update People ---
  server.tool(
    "bulk_update_people",
    "Update up to 10 people in Copper in a single request. Each entry must include the person's `id` (from search_people or get_person) plus only the fields to change.",
    {
      people: z.array(z.object({
        id: z.number().describe("Copper person ID to update"),
        ...personWritableFields,
      }))
        .min(1)
        .max(10)
        .describe("People to update (1-10 per request — Copper's bulk-update limit)"),
    },
    async ({ people }) => {
      const payload = people.map((p) => ({ id: p.id, ...buildPersonFields(p) }));

      const result = await copperFetch("/people/bulk_update", { method: "POST", body: { people: payload } });
      return jsonResult(result);
    }
  );

  // --- Delete Person ---
  server.tool(
    "delete_person",
    "Permanently delete a person (contact) from Copper CRM. This cannot be undone. Use search_people or get_person first to confirm the person_id.",
    {
      person_id: z.number().describe("Copper person ID to delete"),
    },
    async ({ person_id }) => {
      const result = await copperFetch(`/people/${person_id}`, { method: "DELETE" });
      return jsonResult(result);
    }
  );

  // --- List Person Activities ---
  server.tool(
    "list_person_activities",
    "List activities (notes, calls, emails) logged against a specific Copper person. Use search_people or get_person first to find the person_id. Excludes system activities (assignee/status changes) by default.",
    {
      person_id: z.number().describe("Copper person ID"),
      include_system: z.boolean().optional().describe("Include system activities like assignee/status changes (default: false)"),
    },
    async ({ person_id, include_system }) => {
      const results = await copperFetch(`/people/${person_id}/activities`, { method: "POST", body: {} });

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

export const smoke = {
  read: [
    { tool: "search_people", args: { page_size: 1 } },
    async ({ call }) => {
      const list = await call("search_people", { page_size: 1 });
      if (list && list.length) await call("get_person", { person_id: list[0].id });
    },
    async ({ call }) => {
      const list = await call("search_people", { page_size: 1 });
      if (list && list.length) await call("list_person_activities", { person_id: list[0].id });
    },
    async ({ call }) => {
      const list = await call("search_people", { page_size: 1 });
      const email = list?.[0]?.emails?.[0]?.email;
      if (email) await call("get_person_by_email", { email });
    },
  ],
  write: [
    async ({ call, stamp }) => {
      const person = await call("create_person", { name: `zzz_${stamp}` });
      try {
        await call("update_person", { person_id: person.id, title: "Smoke Test", tags: ["smoke"] });
      } finally {
        await call("delete_person", { person_id: person.id });
      }
    },
    async ({ call, stamp }) => {
      const created = await call("bulk_create_people", {
        people: [
          { name: `zzz_${stamp}_bulk1` },
          { name: `zzz_${stamp}_bulk2` },
        ],
      });
      try {
        await call("bulk_update_people", {
          people: created.map((p) => ({ id: p.id, title: "Smoke Bulk" })),
        });
      } finally {
        for (const p of created) {
          await call("delete_person", { person_id: p.id });
        }
      }
    },
  ],
};
