import { z } from "zod";
import { copperFetch } from "../copper.js";
import { jsonResult } from "../result.js";

// Tags. https://developer.copper.com/tags/overview.html
// A Tag is just a string that can be associated with any of Copper's 6 core entities
// (Leads, People, Companies, Opportunities, Tasks, Projects). Copper exposes exactly one
// tags-specific endpoint — listing them — so this module is read-only. Tags themselves are
// created/removed via the owning entity's own `tags` field (e.g. create_person/update_person's
// `tags` array in people.js), not through a dedicated tags endpoint.

const SORT_BY_VALUES = ["name", "count"];

export function register(server) {
  // --- List Tags ---
  server.tool(
    "list_tags",
    "List all tags in use across Copper (Leads, People, Companies, Opportunities, Tasks, Projects). By default returns each tag with its usage counts; set tag_names_only for a plain array of tag name strings instead.",
    {
      sort_by: z.enum(SORT_BY_VALUES).optional().describe("Sort tags by `name` or `count` (default: name). Only applies when tag_names_only is false/omitted."),
      tag_names_only: z.boolean().optional().describe("If true, return only an array of tag name strings (no usage counts). Default: false."),
      last_tag_value: z.string().optional().describe("Pagination cursor: the last tag name already seen (alphabetical order). Returns tags after it. Only applies when tag_names_only is true."),
    },
    async ({ sort_by, tag_names_only, last_tag_value }) => {
      const params = new URLSearchParams();
      if (sort_by !== undefined) params.set("sort_by", sort_by);
      if (tag_names_only !== undefined) params.set("tag_names_only", String(tag_names_only));
      if (last_tag_value !== undefined) params.set("last_tag_value", last_tag_value);

      const qs = params.toString();
      // GET /tags — the resource's only operation. Full result returned as-is (small list),
      // no trimming: shape depends on tag_names_only (array of {name, count, ...} vs array of strings).
      const result = await copperFetch(`/tags${qs ? `?${qs}` : ""}`);
      return jsonResult(result);
    }
  );
}

export const smoke = {
  read: [
    { tool: "list_tags", args: {} },
    { tool: "list_tags", args: { tag_names_only: true } },
  ],
  write: [],
};
