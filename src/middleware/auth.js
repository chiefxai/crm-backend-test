const { runWithScope } = require("../workspaces/scope");
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

const policy = require('../authorization/policy');
const workspaces = require('../db/repositories/workspaceRepository');
const { multipleWorkspacesEnabled } = require('../workspaces/capabilities');
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

// This predicate must return a Boolean. Returning a Promise makes a false
// administrator decision truthy at synchronous authorization call sites.
function isPlatformAdminIdentity(payload, email) {
  if (payload?.platformAdmin === true || payload?.admin === true) return true;
  if (Array.isArray(payload?.realm_access?.roles) && payload.realm_access.roles.includes("platform-admin")) return true;
  const allowed = (process.env.PLATFORM_ADMIN_EMAILS || "")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return allowed.length > 0 && !!email && allowed.includes(String(email).toLowerCase());
}

function resolvePayload(req, token) {
  return provider.verifyToken(token);
}

async function resolveAuthorization({ userId,email,orgId,workspaceId,platformAdmin = false,membership: knownMembership }) {
  if (isDevMode() && orgId === DEV_ORG_ID && userId === DEV_USER_ID) return policy.authorization({ orgRole: 'Organization Admin',workspaceRole: 'Workspace Admin' });
  if (workspaceId !== orgId && !multipleWorkspacesEnabled()) throw Object.assign(new Error('Workspace is unavailable until multi-workspace isolation is enabled'),{ statusCode: 403 });
  const membership = knownMembership === undefined ? await db.findMembershipForUser(userId,email,orgId) : knownMembership;
  if (!membership && !platformAdmin) throw Object.assign(new Error('Active organization membership required'),{ statusCode: 403 });
  let state = await workspaces.getAuthorizationState(orgId,workspaceId,membership?.memberId);
  if (!state) { await workspaces.getDefault(orgId); state = await workspaces.getAuthorizationState(orgId,workspaceId,membership?.memberId); }
  if (!state || state.workspace_status !== 'Active' || state.organization_status === 'Suspended') throw Object.assign(new Error('Active workspace required'),{ statusCode: 403 });
  if (membership?.memberId && !state.role && workspaceId === orgId) {
    // Only legacy imports without any assignment are reconciled. Inactive
    // assignments are preserved and never reactivated by authentication.
    await workspaces.ensureDefaultMembership(orgId,membership.memberId);
    state = await workspaces.getAuthorizationState(orgId,workspaceId,membership.memberId);
  }
  let workspaceRole = null;
  if (membership?.memberId && state?.status === 'Active') {
    workspaceRole = state.role_source === 'legacy' && workspaceId === orgId
      ? policy.legacyWorkspaceRole(membership.role)
      : (policy.WORKSPACE_ROLES.includes(state.role) ? state.role : null);
  }
  return policy.authorization({ orgRole: policy.organizationRole(membership?.role),workspaceRole,platformAdmin });
}
function attachAuthorization(req,value) {
  req.authorization = value;
  req.organizationRole = value.organizationRole;
  req.workspaceRole = value.workspaceRole;
  req.isPlatformAdmin = value.platformAdmin;
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "Missing Authorization: Bearer <token>" });

  if (isDevMode()) {
    req.userId = DEV_USER_ID; req.userEmail = "dev@localhost";
    req.userName = "Dev User"; req.orgId = DEV_ORG_ID; req.workspaceId = DEV_ORG_ID; req.userRole = "Organization Admin";
    attachAuthorization(req,policy.authorization({ orgRole: 'Organization Admin',workspaceRole: 'Workspace Admin' }));
    res.set("X-Organization-Id", req.orgId);
    res.set("X-Workspace-Id", req.workspaceId);
    return runWithScope({ orgId: req.orgId, workspaceId: req.workspaceId }, () => policy.enforceRequest(req,res,next));
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
    let membership = await db.findMembershipForUser(userId, userEmail, requestedOrgId);

    // Platform admins can explicitly switch into any active customer workspace.
    // Normal users remain restricted to their own org memberships.
    if (!membership?.orgId && requestedOrgId && isPlatformAdminIdentity(payload, userEmail)) {
      const selectedOrg = await db.getOrg(requestedOrgId);
      if (!selectedOrg) return res.status(404).json({ error: "Selected workspace not found" });
      membership = { orgId: selectedOrg.id, role: "Super Admin", name: payload.name || userEmail, featureFlags: selectedOrg.featureFlags || [] };
    }

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

    // During the expansion phase only the migrated default workspace is
    // routable. Reject child IDs explicitly rather than silently serving
    // organization-wide data under a different workspace label.
    const requestedWorkspaceId = String(req.get("X-Workspace-Id") || "").trim();
    if (requestedWorkspaceId && requestedWorkspaceId !== membership.orgId && !multipleWorkspacesEnabled()) {
      return res.status(403).json({ error: "Workspace is unavailable until multi-workspace isolation is enabled" });
    }
    req.workspaceId = requestedWorkspaceId || membership.orgId;
    req.userId    = userId;
    req.userEmail = userEmail;
    req.userName  = payload.name || membership.name || null;
    req.orgId     = membership.orgId;
    req.userRole  = membership.role;
    req.authClaims = payload;
    req.orgFeatureFlags = Array.isArray(org.featureFlags) ? org.featureFlags : [];
    req.memberFeatureFlags = Array.isArray(membership.featureFlags) ? membership.featureFlags : [];
    attachAuthorization(req,await resolveAuthorization({ userId,email: userEmail,orgId: req.orgId,workspaceId: req.workspaceId,
      platformAdmin: isPlatformAdminIdentity(payload,userEmail),membership }));
    res.set("X-Organization-Id", req.orgId);
    res.set("X-Workspace-Id", req.workspaceId);
    return runWithScope({ orgId: req.orgId, workspaceId: req.workspaceId }, () => policy.enforceRequest(req,res,next));
  } catch (err) {
    log.error("❌ auth.js: token verification failed:", err.message);
    return res.status(err.statusCode || 401).json({ error: err.statusCode ? err.message : "Invalid or expired token" });
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
  const payload = Buffer.from(JSON.stringify({ sub: req.userId, email: req.userEmail || null, orgId: req.orgId, workspaceId: req.workspaceId || req.orgId, role: req.userRole, platformAdmin: req.isPlatformAdmin === true, exp: Math.floor(Date.now()/1000) + ttlSeconds, jti: crypto.randomUUID() })).toString("base64url");
  const sig = crypto.createHmac("sha256", getSseTicketSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifySseTicket(ticket) {
  if (!ticket || typeof ticket !== "string") return null;
  const [payload, sig, extra] = ticket.split(".");
  if (extra !== undefined) return null;
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", getSseTicketSecret()).update(payload).digest("base64url");
  const a=Buffer.from(sig), b=Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return null;
  try { const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8")); return data.exp > Math.floor(Date.now()/1000) ? data : null; } catch { return null; }
}
async function requireSseTicket(req, res, next) {
  try {
    const data = verifySseTicket(req.query.ticket);
    if (!data) return res.status(401).json({ error: "Invalid or expired SSE ticket" });
    req.userId = data.sub; req.userEmail = data.email; req.orgId = data.orgId;
    req.workspaceId = data.workspaceId || data.orgId; req.userRole = data.role;
    attachAuthorization(req,await resolveAuthorization({ userId: data.sub,email: data.email,orgId: data.orgId,
      workspaceId: req.workspaceId,platformAdmin: data.platformAdmin === true }));
    if (!policy.hasPermission(req,'workspace.read')) return res.status(403).json({ error: 'Workspace read access required' });
    return runWithScope({ orgId: req.orgId, workspaceId: req.workspaceId }, next);
  } catch { return res.status(401).json({ error: "Invalid SSE ticket" }); }
}

function getWebSocketTicketSecret() {
  const secret = process.env.WS_TICKET_SECRET || process.env.SSE_TICKET_SECRET || process.env.INTERNAL_API_SECRET;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("WS_TICKET_SECRET is required in production");
  return secret || "dev-ws-ticket-secret";
}
function createWebSocketTicket(req, ttlSeconds = 60) {
  const payload = Buffer.from(JSON.stringify({
    sub: req.userId, email: req.userEmail || null, orgId: req.orgId, workspaceId: req.workspaceId || req.orgId, role: req.userRole, platformAdmin: req.isPlatformAdmin === true,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds, jti: crypto.randomUUID(), purpose: "browser-ws"
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", getWebSocketTicketSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifyWebSocketTicket(ticket) {
  if (!ticket || typeof ticket !== "string") return null;
  const [payload, sig, extra] = ticket.split(".");
  if (extra !== undefined) return null;
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
  if (isPlatformAdminIdentity(req.authClaims, req.userEmail)) {
    return next();
  }
  return res.status(403).json({
    error: `${req.userEmail || "This account"} is not on the platform-admin allowlist. This is the operator panel, not the customer dashboard.`,
  });
}

module.exports = { resolveAuthorization, requirePermission: policy.requirePermission, hasPermission: policy.hasPermission, isPlatformAdminIdentity, requireAuth, requireAuthIdentityOnly, requireInternalService, requireAuthOrInternal, requireRole, createSseTicket, requireSseTicket, createWebSocketTicket, verifyWebSocketTicket, requirePlatformAdmin, ADMIN_ROLES, DEV_ORG_ID, DEV_USER_ID };
