// Central module manifest. The coordinator maintains this list — add a resource module here as
// it lands (Phases 1-3). Keys are the module name used by `smoke --only <name>`.
//
// Each tools/*.js module exports:
//   register(server)  — registers its server.tool(...) definitions
//   smoke             — { read: [...], write: [...] } checks (see scripts/smoke.mjs)

import * as people from "./tools/people.js";
import * as companies from "./tools/companies.js";
import * as leads from "./tools/leads.js";
import * as opportunities from "./tools/opportunities.js";
import * as projects from "./tools/projects.js";
import * as tasks from "./tools/tasks.js";
import * as activities from "./tools/activities.js";
import * as tags from "./tools/tags.js";
import * as users from "./tools/users.js";
import * as reference from "./tools/reference.js";
import * as relatedItems from "./tools/relatedItems.js";
// Phase 3 (customFields, connectFields, fieldLayouts, files, webhooks) is OUT OF SCOPE — those
// modules are intentionally not built (per user); the MCP must not expose them.

export const MODULES = {
  people,
  companies,
  leads,
  opportunities,
  projects,
  tasks,
  activities,
  tags,
  users,
  reference,
  relatedItems,
};

export function registerAll(server) {
  for (const mod of Object.values(MODULES)) mod.register(server);
}
