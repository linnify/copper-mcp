// Smoke-test harness. Boots the MCP server in-memory and calls tools THROUGH the MCP protocol
// (zod validation -> handler -> Copper API), so a check passes exactly when Copper returns HTTP 200.
//
// Usage:
//   npm run smoke                          # all wired modules, read checks only
//   npm run smoke -- --only people         # one module (dynamic-imported if not yet wired in register.js)
//   npm run smoke -- --write               # also run write checks (create -> delete on the sandbox)
//   npm run smoke -- --only leads --write
//
// All traffic is routed to the SANDBOX account (COPPER_SANDBOX_*) so production is never mutated.
// Write checks additionally require --write (or COPPER_SMOKE_WRITE=1) and sandbox credentials.
//
// A module (src/tools/<name>.js) exposes checks via:
//   export const smoke = {
//     read:  [ { tool, args }  |  async (ctx) => {...} ],   // read-only; safe
//     write: [ async (ctx) => {...} ],                      // create -> [update] -> delete, cleanup in finally
//   };
// ctx = { call(tool, args), fetch(path, opts), stamp } where `call` invokes the real MCP tool,
// `fetch` is raw copperFetch (for cross-entity fixtures), and `stamp` is a unique run id for naming.

// 1) Route ALL smoke traffic to the sandbox account BEFORE importing anything that reads env.
if (process.env.COPPER_SANDBOX_API_KEY) {
  process.env.COPPER_API_KEY = process.env.COPPER_SANDBOX_API_KEY;
  process.env.COPPER_USER_EMAIL = process.env.COPPER_SANDBOX_USER_EMAIL;
  process.env.COPPER_USER_ID = process.env.COPPER_SANDBOX_USER_ID;
}

const argv = process.argv.slice(2);
const only = (() => { const i = argv.indexOf("--only"); return i >= 0 ? argv[i + 1] : null; })();
const writeEnabled = argv.includes("--write") || process.env.COPPER_SMOKE_WRITE === "1";
const hasSandbox = !!process.env.COPPER_SANDBOX_API_KEY;

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { copperFetch } = await import("../src/copper.js");

// 2) Resolve which modules to test. `--only` imports just that one file — so a parallel builder
//    editing a different module can't break this run. The ALL case pulls the wired manifest.
let targets;
if (only) {
  const mod = await import(`../src/tools/${only}.js`);
  targets = [[only, mod]];
} else {
  const { MODULES } = await import("../src/register.js");
  targets = Object.entries(MODULES);
}

// 3) Register the target modules on a fresh server and link an in-memory client.
const server = new McpServer({ name: "copper-smoke", version: "1.0.0" });
for (const [, mod] of targets) mod.register(server);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "smoke-client", version: "1.0.0" });
await server.connect(serverTransport);
await client.connect(clientTransport);

// 4) Context handed to check functions.
const stamp = `mcp_smoke_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
async function call(tool, argObj) {
  const res = await client.callTool({ name: tool, arguments: argObj ?? {} });
  if (res.isError) {
    const msg = (res.content ?? []).map((c) => c.text).join(" ") || "unknown error";
    throw new Error(msg);
  }
  const text = res.content?.[0]?.text;
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}
const ctx = { call, fetch: copperFetch, stamp };

async function runCheck(chk) {
  return typeof chk === "function" ? chk(ctx) : call(chk.tool, chk.args);
}

// A disabled Copper feature (e.g. Leads toggled off on this account) is an environment limitation,
// not a code failure — report it as SKIP so it doesn't turn a correct build red.
const statusForError = (e) => (/Feature not enabled/i.test(e.message) ? "SKIP" : "FAIL");

// 5) Run checks.
const results = [];
for (const [name, mod] of targets) {
  const s = mod.smoke ?? { read: [], write: [] };

  let i = 0;
  for (const chk of s.read ?? []) {
    const label = `${name} read#${i++}${chk.tool ? ` ${chk.tool}` : ""}`;
    try { await runCheck(chk); results.push({ label, status: "PASS" }); }
    catch (e) { results.push({ label, status: statusForError(e), error: e.message }); }
  }

  i = 0;
  for (const chk of s.write ?? []) {
    const label = `${name} write#${i++}`;
    if (!writeEnabled) { results.push({ label, status: "SKIP", error: "writes off" }); continue; }
    if (!hasSandbox) { results.push({ label, status: "SKIP", error: "no sandbox creds" }); continue; }
    try { await runCheck(chk); results.push({ label, status: "PASS" }); }
    catch (e) { results.push({ label, status: statusForError(e), error: e.message }); }
  }
}

// 6) Report.
const count = (st) => results.filter((r) => r.status === st).length;
for (const r of results) {
  const icon = r.status === "PASS" ? "PASS" : r.status === "FAIL" ? "FAIL" : "SKIP";
  console.log(`[${icon}] ${r.label}${r.error && r.status !== "PASS" ? `  — ${r.error}` : ""}`);
}
console.log(`\n${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped  (writes ${writeEnabled ? "ON" : "OFF"}, target ${only ?? "ALL"})`);

await client.close();
await server.close();
process.exit(count("FAIL") > 0 ? 1 : 0);
