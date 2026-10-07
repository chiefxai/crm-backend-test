// src/middleware/auth.js
//
// Provider-agnostic JWT authentication middleware.
// Switch providers via AUTH_PROVIDER env var (keycloak | identity_platform | cognito).
//
// Token flow:
//   1. Extract Bearer token from the Authorization header.
//   2. Verify JWT via the configured auth provider.
//   3. Look up org membership from app DB.
//   4. Check org suspension.
//   5. Attach req.userId, req.userEmail, req.userName, req.orgId, req.userRole.
//
// Dev-mode: no configured auth provider in a non-production environment:
//   Every request is treated as DEV_USER_ID in DEV_ORG_ID — no token check.

const jwt      = require("jsonwebtoken");
const db       = require("../db/repository");
const provider = require("../auth");        // plug-and-play provider
const { getLogger } = require("../observability/logger");
const log = getLogger("middleware.auth");
const crypto = require("crypto");

const DEV_ORG_ID  = "dev-org";
const DEV_USER_ID = "dev-user";
const ADMIN_ROLES = ["Super Admin", "Organization Admin"];

// Dev-mode detection: no auth config present AND not running in production.
// Requiring NODE_ENV !== "production" too means a forgotten/misconfigured
// provider env var in prod fails closed (500 from resolvePayload) instead of
// silently granting every caller Organization Admin access.
function isDevMode() {
  if (process.env.NODE_ENV === "production") return false;
  const p = (process.env.AUTH_PROVIDER || "cognito").toLowerCase();
  if (p === "identity_platform") return !process.env.IDENTITY_PLATFORM_PROJECT_ID && !process.env.GOOGLE_CLOUD_PROJECT;
  if (p === "cognito") return !process.env.COGNITO_REGION || !process.env.COGNITO_USER_POOL_ID || !process.env.COGNITO_CLIENT_ID;
  return !process.env.KEYCLOAK_URL;
}

function extractToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return null;
}

async function resolvePayload(req, token) {
  return provider.verifyToken(token);
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "Missing Authorization: Bearer <token>" });

  if (isDevMode()) {
    req.userId = DEV_USER_ID; req.userEmail = "dev@localhost";
    req.userName = "Dev User"; req.orgId = DEV_ORG_ID; req.userRole = "Organization Admin";
    return next();
  }

  try {
    const payload = await resolvePayload(req, token);
    if (!payload?.sub) {
      log.error("❌ auth.js: missing sub. keys:", payload ? Object.keys(payload) : null);
      return res.status(401).json({ error: "Invalid token payload" });
    }

    const userId    = payload.sub;
    const userEmail = payload.email || null;

    // The workspace switcher sends the selected organization explicitly.
    // The database membership lookup remains the authorization boundary.
    const requestedOrgId = String(req.get("X-Organization-Id") || "").trim() || null;
    const membership = await db.findMembershipForUser(userId, userEmail, requestedOrgId);
    if (!membership?.orgId) {
      return res.status(403).json({ error: "This account is not a member of any organization" });
    }

    const org = await db.getOrg(membership.orgId);
    if (!org) {
      return res.status(403).json({ error: "The organization for this account no longer exists." });
    }
    if (org.status === "Suspended") {
      return res.status(403).json({ error: "This organization has been suspended. Contact support for details." });
    }

    req.userId    = userId;
    req.userEmail = userEmail;
    req.userName  = payload.name || membership.name || null;
    req.orgId     = membership.orgId;
    req.userRole  = membership.role;
    return next();
  } catch (err) {
    log.error("❌ auth.js: token verification failed:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Skips org membership check — used for platform admin routes where the
// admin may not belong to any customer org.
async function requireAuthIdentityOnly(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "Missing Authorization: Bearer <token>" });

  if (isDevMode()) {
    req.userId = DEV_USER_ID; req.userEmail = "dev@localhost"; req.userName = "Dev User";
    return next();
  }

  try {
    let payload = await resolvePayload(req, token);
    if (!payload?.sub) return res.status(401).json({ error: "Invalid token payload" });
    req.userId         = payload.sub;
    req.userEmail      = payload.email || payload.preferred_username || null;
    req.userName       = payload.name || null;
    req.authClaims = payload;
    req.keycloakRoles = payload.realm_access?.roles || [];
    log.info("🔐 identity token verified", { userId: payload.sub, provider: process.env.AUTH_PROVIDER || "cognito" });
    return next();
  } catch (err) {
    log.error("❌ auth.js: token verification failed:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function getSseTicketSecret() {
  const secret = process.env.SSE_TICKET_SECRET || process.env.INTERNAL_API_SECRET;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("SSE_TICKET_SECRET is required in production");
  return secret || "dev-sse-ticket-secret";
}
function createSseTicket(req, ttlSeconds = 60) {
  const payload = Buffer.from(JSON.stringify({ sub: req.userId, email: req.userEmail || null, orgId: req.orgId, role: req.userRole, exp: Math.floor(Date.now()/1000) + ttlSeconds, jti: crypto.randomUUID() })).toString("base64url");
  const sig = crypto.createHmac("sha256", getSseTicketSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifySseTicket(ticket) {
  if (!ticket || typeof ticket !== "string") return null;
  const [payload, sig] = ticket.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", getSseTicketSecret()).update(payload).digest("base64url");
  const a=Buffer.from(sig), b=Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return null;
  try { const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8")); return data.exp > Math.floor(Date.now()/1000) ? data : null; } catch { return null; }
}
function requireSseTicket(req, res, next) {
  try { const data=verifySseTicket(req.query.ticket); if (!data) return res.status(401).json({error:"Invalid or expired SSE ticket"}); req.userId=data.sub; req.userEmail=data.email; req.orgId=data.orgId; req.userRole=data.role; return next(); } catch (err) { return res.status(401).json({error:"Invalid SSE ticket"}); }
}

function getWebSocketTicketSecret() {
  const secret = process.env.WS_TICKET_SECRET || process.env.SSE_TICKET_SECRET || process.env.INTERNAL_API_SECRET;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("WS_TICKET_SECRET is required in production");
  return secret || "dev-ws-ticket-secret";
}
function createWebSocketTicket(req, ttlSeconds = 60) {
  const payload = Buffer.from(JSON.stringify({
    sub: req.userId, email: req.userEmail || null, orgId: req.orgId, role: req.userRole,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds, jti: crypto.randomUUID(), purpose: "browser-ws"
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", getWebSocketTicketSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifyWebSocketTicket(ticket) {
  if (!ticket || typeof ticket !== "string") return null;
  const [payload, sig] = ticket.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", getWebSocketTicketSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.purpose === "browser-ws" && data.exp > Math.floor(Date.now() / 1000) ? data : null;
  } catch { return null; }
}

function requireInternalService(req, res, next) {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected) return res.status(503).json({ error: "Internal service authentication is not configured" });
  const supplied = req.get("X-Internal-Service-Token") || "";
  if (!supplied || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return res.status(401).json({ error: "Invalid internal service credentials" });
  req.isInternalService = true;
  return next();
}
function requireAuthOrInternal(req, res, next) {
  return req.get("X-Internal-Service-Token") ? requireInternalService(req, res, next) : requireAuth(req, res, next);
}
function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.userRole || !allowedRoles.includes(req.userRole)) {
      return res.status(403).json({ error: `This action requires one of: ${allowedRoles.join(", ")}` });
    }
    next();
  };
}

function requirePlatformAdmin(req, res, next) {
  log.info("🔐 requirePlatformAdmin check", { userId: req.userId, provider: process.env.AUTH_PROVIDER || "cognito" });
  // Identity Platform custom claims are provider-neutral and are suitable for
  // platform-level privileges. The CRM membership role remains the source of
  // truth for customer-organization authorization.
  if (req.authClaims?.platformAdmin === true || req.authClaims?.admin === true) {
    return next();
  }
  // Keycloak development compatibility.
  if (Array.isArray(req.keycloakRoles) && req.keycloakRoles.includes("platform-admin")) {
    return next();
  }
  // Fall back to email allowlist
  const allowed = (process.env.PLATFORM_ADMIN_EMAILS || "")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && req.userEmail && allowed.includes(req.userEmail.toLowerCase())) {
    return next();
  }
  return res.status(403).json({
    error: `${req.userEmail || "This account"} is not on the platform-admin allowlist. This is the operator panel, not the customer dashboard.`,
  });
}

module.exports = { requireAuth, requireAuthIdentityOnly, requireInternalService, requireAuthOrInternal, requireRole, createSseTicket, requireSseTicket, createWebSocketTicket, verifyWebSocketTicket, requirePlatformAdmin, ADMIN_ROLES, DEV_ORG_ID, DEV_USER_ID };
