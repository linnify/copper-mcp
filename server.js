import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- Config ---
const API_KEY = process.env.COPPER_API_KEY;
const USER_EMAIL = process.env.COPPER_USER_EMAIL;
if (!API_KEY || !USER_EMAIL) {
  console.error("COPPER_API_KEY and COPPER_USER_EMAIL environment variables are required");
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
    details: z.string().describe("Activity content — meeting notes, action items, summary, etc."),
    activity_date: z.number().optional().describe("Unix timestamp for when the activity occurred (default: now)"),
  },
  async ({ parent_type, parent_id, activity_type_id, details, activity_date }) => {
    const body = {
      parent: { type: parent_type, id: parent_id },
      type: { id: activity_type_id, category: "user" },
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

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
