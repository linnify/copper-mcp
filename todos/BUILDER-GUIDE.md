# Builder Guide — implementing one Copper MCP tool module

You implement **one** file: `src/tools/<module>.js`, bringing a Copper resource to full API parity as MCP tools. Read this + `CLAUDE.md` + the existing `src/tools/people.js` (the pattern) before writing.

## Hard rules
- **Edit ONLY your `src/tools/<module>.js`.** Do NOT touch `src/copper.js`, `src/result.js`, `src/resolve.js`, `src/register.js`, `src/buildServer.js`, `server.js`, `scripts/smoke.mjs`, or `package.json`. If you believe a shared helper must change, STOP and say so in your report — the coordinator handles shared files.
- **Keep any tools already in the file working** — add/expand, don't regress.
- All HTTP goes through `copperFetch` from `../copper.js`. Never call `fetch` directly.

## Module contract (exports)
```js
import { z } from "zod";
import { copperFetch } from "../copper.js";
import { jsonResult } from "../result.js";
// import { resolveParentName } from "../resolve.js"; // only if you resolve parent {type,id} names

export function register(server) {
  server.tool(name, description, zodShape, handler);   // one per operation
}

export const smoke = { read: [ /* ... */ ], write: [ /* ... */ ] };
```

## Tool-authoring conventions
- `server.tool(name, description, zodShape, asyncHandler)`. Names are snake_case (see your operation table).
- **`.describe()` on EVERY zod field** — it's the model's only guidance. Mark optionals `.optional()`.
- **Search** = `POST /{resource}/search`; pagination in the body: `page_size` (default 20, **max 200**), `page_number` (1-based). Add `sort_by`/`sort_direction` where the doc lists them. **Trim** list/search results to the useful fields (mirror `search_people`).
- **Reads that use POST** (`*/search`, `*/{id}/activities`, `fetch_by_email`) are still read-only.
- **`get_*`** returns the full record (no trimming).
- **create/update**: send ONLY provided fields — `if (x !== undefined) body.x = x`. Update is `PUT /{resource}/{id}`.
- **Dates** are Unix timestamps (seconds). **Parent refs** are `{ type, id }` (`lead|person|company|opportunity|project|task`).
- **Read the Copper doc sub-page for each operation** to get the exact request-body fields. Load WebFetch first: `ToolSearch("select:WebFetch")`. ⚠️ **Trust the operation SUB-PAGE, never the resource overview table** — the overview auto-renders WRONG methods (e.g. PATCH where the real verb is PUT/POST).

## Smoke checks (how you verify — REQUIRED)
Export `smoke = { read, write }`:
- `read`: array of `{ tool, args }` **or** `async (ctx) => {...}`. Read-only, safe. For a `get_*`, discover an id first (call the `search_*` and use `result[0].id`); if the account has none, just return (skip).
- `write`: array of `async (ctx) => {...}`. Each must **create → [update] → delete**, deleting everything it created in a `finally` block. Name test records with `` `zzz_${ctx.stamp}` `` so strays are identifiable.

`ctx = { call, fetch, stamp }`:
- `call(tool, args)` → invokes the real MCP tool, returns its parsed JSON result, **throws if the tool errors or Copper returns non-200**. This is your assertion — no throw = HTTP 200 = pass.
- `fetch(path, { method, body })` → raw `copperFetch`, for **cross-entity fixtures** (e.g. create a parent person for an activity). Delete those too.
- `stamp` → unique run id for naming.

Example (create → update → delete, with a cross-entity fixture):
```js
export const smoke = {
  read: [
    { tool: "search_leads", args: { page_size: 1 } },
    async ({ call }) => { const r = await call("search_leads", { page_size: 1 }); if (r?.length) await call("get_lead", { lead_id: r[0].id }); },
  ],
  write: [
    async ({ call, stamp }) => {
      const lead = await call("create_lead", { name: `zzz_${stamp}` });
      try { await call("update_lead", { lead_id: lead.id, title: "smoke" }); }
      finally { await call("delete_lead", { lead_id: lead.id }); }
    },
  ],
};
```

## Verify before reporting
Run until **every check passes** (each pass = HTTP 200 against the sandbox):
```
npm run smoke -- --only <module> --write
```
Reads run always; writes create+delete on the sandbox account. If a write leaves residue because an assertion failed mid-way, fix the cleanup.

## Report back
- Tools implemented (names).
- The final `npm run smoke -- --only <module> --write` output (paste it).
- Any doc ambiguity, unexpected API behavior, or shared-helper need.
