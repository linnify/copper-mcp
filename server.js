import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- Config ---
const API_KEY = process.env.COPPER_API_KEY;
const USER_EMAIL = process.env.COPPER_USER_EMAIL;
const USER_ID = process.env.COPPER_USER_ID;
if (!API_KEY || !USER_EMAIL || !USER_ID) {
  console.error("COPPER_API_KEY, COPPER_USER_EMAIL, and COPPER_USER_ID environment variables are required");
  process.exit(1);
}

const BASE_URL = "https://api.copper.com/developer_api/v1";
const HEADERS = {
  "X-PW-AccessToken": API_KEY,
  "X-PW-Application": "developer_api",
  "X-PW-UserEmail": USER_EMAIL,
  "Content-Type": "application/json",
};

async function copperFetch(path, { method = "GET", body } = {}) {
  const opts = { method, headers: HEADERS };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Copper API ${res.status}: ${text}`);
  }
  return res.json();
}

// --- Name Resolution Cache (per-request, reset each call) ---
async function resolveParentName(type, id, cache) {
  const key = `${type}:${id}`;
  if (cache.has(key)) return cache.get(key);

  const endpoints = {
    person: `/people/${id}`,
    company: `/companies/${id}`,
    lead: `/leads/${id}`,
    opportunity: `/opportunities/${id}`,
  };

  const endpoint = endpoints[type];
  if (!endpoint) {
    const fallback = `${type} #${id}`;
    cache.set(key, fallback);
    return fallback;
  }

  try {
    const record = await copperFetch(endpoint);
    const name = record.name || record.first_name
      ? [record.first_name, record.last_name].filter(Boolean).join(" ") || record.name
      : `${type} #${id}`;
    cache.set(key, name);
    return name;
  } catch {
    const fallback = `${type} #${id}`;
    cache.set(key, fallback);
    return fallback;
  }
}

function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(msg) {
  return { content: [{ type: "text", text: JSON.stringify({ error: msg }, null, 2) }], isError: true };
}

// --- Server ---
const server = new McpServer({
  name: "copper-crm",
  version: "1.0.0",
});

// --- Tool 1: Search People ---
server.tool(
  "search_people",
  "Search Copper contacts by name, email, or phone. Returns matching person records with IDs for use in create_activity.",
  {
    name: z.string().optional().describe("Full name or partial name to search"),
    emails: z.array(z.string()).optional().describe("Email addresses to match"),
    phone_number: z.string().optional().describe("Phone number to match"),
    page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
    page_number: z.number().optional().describe("Page number (default 1)"),
  },
  async ({ name, emails, phone_number, page_size, page_number }) => {
    const body = {};
    if (name) body.name = name;
    if (emails) body.emails = emails;
    if (phone_number) body.phone_number = phone_number;
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
    }));
    return jsonResult(people);
  }
);

// --- Tool 2: Get Person ---
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

// --- Tool 2b: Create Person ---
server.tool(
  "create_person",
  "Create a new person (contact) in Copper CRM.",
  {
    first_name: z.string().describe("First name"),
    last_name: z.string().describe("Last name"),
    title: z.string().optional().describe("Job title"),
    company_name: z.string().optional().describe("Company name (Copper auto-links or creates)"),
    emails: z.array(z.object({
      email: z.string(),
      category: z.enum(["work", "personal", "other"]).optional()
    })).optional().describe("Email addresses"),
    phone_numbers: z.array(z.object({
      number: z.string(),
      category: z.enum(["work", "mobile", "home", "other"]).optional()
    })).optional().describe("Phone numbers"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
    contact_type_id: z.number().optional().describe("Contact type ID (e.g. Potential Customer)"),
  },
  async ({ first_name, last_name, title, company_name, emails, phone_numbers, tags, contact_type_id }) => {
    const body = { name: `${first_name} ${last_name}` };
    if (first_name) body.first_name = first_name;
    if (last_name) body.last_name = last_name;
    if (title) body.title = title;
    if (company_name) body.company_name = company_name;
    if (emails) body.emails = emails;
    if (phone_numbers) body.phone_numbers = phone_numbers;
    if (tags) body.tags = tags;
    if (contact_type_id) body.contact_type_id = contact_type_id;

    const result = await copperFetch("/people", { method: "POST", body });
    return jsonResult(result);
  }
);

// --- Tool 2c: Update Person ---
server.tool(
  "update_person",
  "Update an existing person (contact) in Copper CRM. Only include fields you want to change. The 'details' field is the 'About' section visible at the top of the contact page.",
  {
    person_id: z.number().describe("Copper person ID to update"),
    details: z.string().optional().describe("About/details text (visible at top of contact page in Copper UI)"),
    title: z.string().optional().describe("Job title"),
    tags: z.array(z.string()).optional().describe("Tags (replaces existing tags)"),
  },
  async ({ person_id, details, title, tags }) => {
    const body = {};
    if (details !== undefined) body.details = details;
    if (title !== undefined) body.title = title;
    if (tags !== undefined) body.tags = tags;

    const result = await copperFetch(`/people/${person_id}`, { method: "PUT", body });
    return jsonResult({
      id: result.id,
      name: result.name,
      details: result.details,
      title: result.title,
      tags: result.tags,
    });
  }
);

// --- Tool 3: Search Companies ---
server.tool(
  "search_companies",
  "Search Copper companies by name. Returns matching company records.",
  {
    name: z.string().optional().describe("Company name to search"),
    page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
    page_number: z.number().optional().describe("Page number (default 1)"),
  },
  async ({ name, page_size, page_number }) => {
    const body = {};
    if (name) body.name = name;
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
    }));
    return jsonResult(companies);
  }
);

// --- Tool 4: List Activity Types ---
server.tool(
  "list_activity_types",
  "List all available activity types in Copper (e.g., Note, Meeting, Phone Call). Returns activity_type_id values needed for create_activity.",
  {},
  async () => {
    const result = await copperFetch("/activity_types");
    return jsonResult(result);
  }
);

// --- Tool 5: Create Activity ---
server.tool(
  "create_activity",
  "Log an activity (meeting note, phone call, etc.) against a Copper person or company. Use list_activity_types first to get the correct activity_type_id.",
  {
    parent_type: z.enum(["person", "company"]).describe("Type of record to log against"),
    parent_id: z.number().describe("Copper ID of the person or company"),
    activity_type_id: z.number().describe("Activity type ID (from list_activity_types)"),
    details: z.string().describe("Activity content — meeting notes, action items, summary, etc. Use plain text, not markdown."),
    activity_date: z.number().optional().describe("Unix timestamp for when the activity occurred (default: now)"),
  },
  async ({ parent_type, parent_id, activity_type_id, details, activity_date }) => {
    const body = {
      parent: { type: parent_type, id: parent_id },
      type: { id: activity_type_id, category: "user" },
      user_id: parseInt(USER_ID),
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

// --- Tool 6: List Opportunities ---
server.tool(
  "list_opportunities",
  "Search Copper opportunities (deals). Optionally filter by company or person. Returns deal name, value, status, and pipeline stage.",
  {
    name: z.string().optional().describe("Opportunity name to search"),
    company_ids: z.array(z.number()).optional().describe("Filter by company IDs"),
    person_ids: z.array(z.number()).optional().describe("Filter by associated person IDs (custom field)"),
    page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
    page_number: z.number().optional().describe("Page number (default 1)"),
  },
  async ({ name, company_ids, person_ids, page_size, page_number }) => {
    const body = {};
    if (name) body.name = name;
    if (company_ids) body.company_ids = company_ids;
    if (person_ids) body.person_ids = person_ids;
    body.page_size = page_size || 20;
    body.page_number = page_number || 1;

    const results = await copperFetch("/opportunities/search", { method: "POST", body });
    const opps = results.map((o) => ({
      id: o.id,
      name: o.name,
      company_id: o.company_id,
      company_name: o.company_name,
      monetary_value: o.monetary_value,
      status: o.status,
      pipeline_id: o.pipeline_id,
      pipeline_stage_id: o.pipeline_stage_id,
      close_date: o.close_date,
      win_probability: o.win_probability,
    }));
    return jsonResult(opps);
  }
);

// --- Tool 7: List/Search Activities ---
server.tool(
  "list_activities",
  "Search Copper activities (meeting notes, calls, emails logged against contacts). Filter by parent record, activity type, or date range. Returns resolved parent names. Excludes system activities (assignee/status changes) by default.",
  {
    parent_type: z.enum(["person", "company", "lead", "opportunity", "project", "task"]).optional().describe("Filter by parent entity type"),
    parent_id: z.number().optional().describe("Filter by parent entity ID (requires parent_type)"),
    minimum_activity_date: z.number().optional().describe("Unix timestamp — only activities on or after this date"),
    maximum_activity_date: z.number().optional().describe("Unix timestamp — only activities on or before this date"),
    include_system: z.boolean().optional().describe("Include system activities like assignee/status changes (default: false)"),
    page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
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

    // Filter out system activities unless explicitly requested
    const filtered = include_system
      ? results
      : results.filter((a) => a.type?.category === "user");

    // Resolve parent names
    const nameCache = new Map();
    const activities = await Promise.all(
      filtered.map(async (a) => {
        const parentType = a.parent?.type;
        const parentId = a.parent?.id;
        const parent_name = parentType && parentId
          ? await resolveParentName(parentType, parentId, nameCache)
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

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
