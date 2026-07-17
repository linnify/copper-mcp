import { z } from "zod";
import { copperFetch } from "../copper.js";
import { jsonResult } from "../result.js";

// Account and Users. https://developer.copper.com/account-and-users/overview.html
// Read-only resource: this is account/seat metadata, not a CRM record — Copper exposes no
// create/update/delete for it via this API.

export function register(server) {
  // --- Get Account ---
  server.tool(
    "get_account",
    "Get the Copper account's metadata: name, primary timezone, logo, and enabled feature settings (e.g. Leads).",
    {},
    async () => {
      const account = await copperFetch("/account");
      return jsonResult(account);
    }
  );

  // --- Get Current User ---
  server.tool(
    "get_current_user",
    "Get full details (id, name, email, groups) of the Copper user that owns the API credentials this server is running as.",
    {},
    async () => {
      const user = await copperFetch("/users/me");
      return jsonResult(user);
    }
  );

  // --- Get User ---
  server.tool(
    "get_user",
    "Get full details (id, name, email, groups) of a Copper user by ID. Use search_users or get_current_user first to find a user_id.",
    {
      user_id: z.number().describe("Copper user ID"),
    },
    async ({ user_id }) => {
      const user = await copperFetch(`/users/${user_id}`);
      return jsonResult(user);
    }
  );

  // --- Search Users ---
  server.tool(
    "search_users",
    "List Copper users (account seats) with pagination. Returns trimmed records (id, name, email) — use get_user for full details including groups.",
    {
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
    },
    async ({ page_size, page_number }) => {
      const body = {};
      body.page_size = page_size || 20;
      body.page_number = page_number || 1;

      const results = await copperFetch("/users/search", { method: "POST", body });
      const users = results.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
      }));
      return jsonResult(users);
    }
  );
}

export const smoke = {
  read: [
    { tool: "get_account", args: {} },
    { tool: "get_current_user", args: {} },
    { tool: "search_users", args: { page_size: 1 } },
    async ({ call }) => {
      const list = await call("search_users", { page_size: 1 });
      let id = list?.[0]?.id;
      if (!id) {
        const me = await call("get_current_user", {});
        id = me?.id;
      }
      if (id) await call("get_user", { user_id: id });
    },
  ],
  write: [],
};
