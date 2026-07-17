// OAuth 2.1 for the remote MCP endpoint. A minimal, STATELESS authorization server embedded in the
// same express app so Claude / ChatGPT can connect to /mcp as an authenticated custom connector.
//
// Model: a single predefined confidential client (OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET — the same
// two values you paste into the Claude connector's OAuth fields). There is no per-user login (this
// server acts as one Copper service account), so /authorize auto-approves; security rests on the
// client secret + PKCE. All artifacts (auth code, access token, refresh token) are short-lived
// HS256 JWTs signed with OAUTH_JWT_SECRET, so nothing needs to be stored — any Cloud Run instance
// can validate any token.
//
// Auth is ENFORCED only when all three env vars are set. Unset (local dev / tests) → server runs open.

import crypto from "node:crypto";

const CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const JWT_SECRET = process.env.OAUTH_JWT_SECRET;

export const authEnabled = !!(CLIENT_ID && CLIENT_SECRET && JWT_SECRET);

const ACCESS_TTL = 3600; // 1h
const REFRESH_TTL = 60 * 60 * 24 * 30; // 30d
const CODE_TTL = 300; // 5m

const nowSec = () => Math.floor(Date.now() / 1000);
const b64urlJson = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function signJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = b64urlJson(payload);
  const data = `${header}.${body}`;
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyJwt(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(data).digest("base64url");
  if (!timingSafeEqualStr(parts[2], expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return null;
  }
  if (!payload.exp || nowSec() > payload.exp) return null;
  return payload;
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Public base URL (issuer). Derived from the forwarded headers Cloud Run sets, or OAUTH_ISSUER.
export function baseUrl(req) {
  if (process.env.OAUTH_ISSUER) return process.env.OAUTH_ISSUER.replace(/\/$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

// --- Redirect URI allowlist (prevents leaking auth codes to arbitrary hosts) ---
const DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com", "anthropic.com", "chatgpt.com", "openai.com", "localhost", "127.0.0.1"];
function isAllowedRedirect(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !isLocal) return false;
  const extra = (process.env.OAUTH_ALLOWED_REDIRECT_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const hosts = new Set([...DEFAULT_REDIRECT_HOSTS, ...extra]);
  return [...hosts].some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

// --- CORS (Bearer tokens, no cookies → wildcard origin is acceptable) ---
export function corsMiddleware(req, res, next) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version");
  res.set("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

// --- Discovery metadata (RFC 8414 / RFC 9728) ---
export function protectedResourceMetadata(req, res) {
  const base = baseUrl(req);
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
  });
}

export function authorizationServerMetadata(req, res) {
  const base = baseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    scopes_supported: ["mcp"],
  });
}

// --- Authorization endpoint (auto-approve; issues a signed code bound to the PKCE challenge) ---
export function authorize(req, res) {
  const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, state, scope, resource } = req.query;

  if (!redirect_uri || !isAllowedRedirect(redirect_uri)) return res.status(400).json({ error: "invalid_request", error_description: "invalid redirect_uri" });
  const redirect = (params) => {
    const u = new URL(redirect_uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    res.redirect(302, u.toString());
  };

  if (client_id !== CLIENT_ID) return redirect({ error: "unauthorized_client", state });
  if (response_type !== "code") return redirect({ error: "unsupported_response_type", state });
  if (!code_challenge || code_challenge_method !== "S256") return redirect({ error: "invalid_request", error_description: "PKCE S256 required", state });

  const code = signJwt({
    t: "code",
    cid: client_id,
    ru: redirect_uri,
    cc: code_challenge,
    aud: resource || `${baseUrl(req)}/mcp`,
    scope: scope || "mcp",
    exp: nowSec() + CODE_TTL,
  });
  redirect({ code, state });
}

function clientCredentials(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Basic ")) {
    const [id, secret] = Buffer.from(auth.slice(6), "base64").toString().split(":");
    return { id: decodeURIComponent(id ?? ""), secret: decodeURIComponent(secret ?? "") };
  }
  if (req.body && req.body.client_id) return { id: req.body.client_id, secret: req.body.client_secret };
  return null;
}

function issueTokens(aud, scope) {
  return {
    access_token: signJwt({ t: "access", aud, scope, exp: nowSec() + ACCESS_TTL }),
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: signJwt({ t: "refresh", aud, scope, exp: nowSec() + REFRESH_TTL }),
    scope,
  };
}

// --- Token endpoint (authorization_code + refresh_token grants) ---
export function token(req, res) {
  const creds = clientCredentials(req);
  if (!creds || creds.id !== CLIENT_ID || !timingSafeEqualStr(creds.secret, CLIENT_SECRET)) {
    return res.status(401).json({ error: "invalid_client" });
  }

  const grant = req.body?.grant_type;
  if (grant === "authorization_code") {
    const payload = verifyJwt(req.body.code);
    if (!payload || payload.t !== "code") return res.status(400).json({ error: "invalid_grant" });
    if (payload.ru !== req.body.redirect_uri) return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
    const challenge = crypto.createHash("sha256").update(String(req.body.code_verifier ?? "")).digest("base64url");
    if (!timingSafeEqualStr(challenge, payload.cc)) return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
    return res.json(issueTokens(payload.aud, payload.scope));
  }

  if (grant === "refresh_token") {
    const payload = verifyJwt(req.body.refresh_token);
    if (!payload || payload.t !== "refresh") return res.status(400).json({ error: "invalid_grant" });
    return res.json(issueTokens(payload.aud, payload.scope));
  }

  return res.status(400).json({ error: "unsupported_grant_type" });
}

// --- Bearer guard for /mcp ---
export function requireAuth(req, res, next) {
  if (!authEnabled) return next();
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const payload = bearer && verifyJwt(bearer);
  if (!payload || payload.t !== "access") {
    res.set("WWW-Authenticate", `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`);
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }
  next();
}
