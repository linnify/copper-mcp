// Copper API config + HTTP layer. This is the ONLY place that talks to Copper over HTTP —
// every tool goes through copperFetch(). Credentials come from env; the smoke harness swaps
// in the sandbox credentials before importing this module (see scripts/smoke.mjs).

const API_KEY = process.env.COPPER_API_KEY;
const USER_EMAIL = process.env.COPPER_USER_EMAIL;
const USER_ID = process.env.COPPER_USER_ID;

if (!API_KEY || !USER_EMAIL || !USER_ID) {
  console.error("COPPER_API_KEY, COPPER_USER_EMAIL, and COPPER_USER_ID environment variables are required");
  process.exit(1);
}

// Numeric Copper user id (used where the API wants a user_id, e.g. creating activities).
export const USER_ID_NUM = parseInt(USER_ID, 10);

const BASE_URL = "https://api.copper.com/developer_api/v1";
const HEADERS = {
  "X-PW-AccessToken": API_KEY,
  "X-PW-Application": "developer_api",
  "X-PW-UserEmail": USER_EMAIL,
  "Content-Type": "application/json",
};

// Perform a Copper API request. Throws `Copper API <status>: <body>` on any non-2xx, so a
// tool/smoke check "passes" (HTTP 200) exactly when this does not throw.
export async function copperFetch(path, { method = "GET", body } = {}) {
  const opts = { method, headers: HEADERS };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Copper API ${res.status}: ${text}`);
  }
  // A few endpoints return an empty 200 body; guard the JSON parse.
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}
