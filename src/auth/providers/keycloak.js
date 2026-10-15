// src/auth/providers/keycloak.js
//
// Required env vars:
//   KEYCLOAK_URL          — internal Docker URL  (e.g. http://keycloak:8080)
//   KEYCLOAK_ISSUER_URL   — public URL matching JWT iss claim (defaults to KEYCLOAK_URL)
//   KEYCLOAK_REALM        — realm name (default: master)
//   KEYCLOAK_ADMIN        — admin username (default: admin)
//   KEYCLOAK_ADMIN_PASSWORD
//   KEYCLOAK_AUDIENCE     — optional aud check

const jwt     = require("jsonwebtoken");
const jwksRsa = require("jwks-rsa");
const { getLogger } = require("../../observability/logger");
const log = getLogger("auth.providers.keycloak");

const URL        = process.env.KEYCLOAK_URL;
const ISSUER_URL = process.env.KEYCLOAK_ISSUER_URL || URL;
const REALM      = process.env.KEYCLOAK_REALM || "master";

let _jwks = null;
function jwksClient() {
  if (!_jwks) {
    _jwks = jwksRsa({
      jwksUri: `${URL}/realms/${REALM}/protocol/openid-connect/certs`,
      cache: true,
      cacheMaxEntries: 10,
      cacheMaxAge: 10 * 60 * 1000,
      rateLimit: true,
    });
  }
  return _jwks;
}

function getSigningKey(header, cb) {
  jwksClient().getSigningKey(header.kid, (err, key) =>
    err ? cb(err) : cb(null, key.getPublicKey())
  );
}

function verifyToken(token) {
  const opts = {
    algorithms: ["RS256"],
    issuer: `${ISSUER_URL}/realms/${REALM}`,
  };
  if (process.env.KEYCLOAK_AUDIENCE) opts.audience = process.env.KEYCLOAK_AUDIENCE;
  return new Promise((resolve, reject) =>
    jwt.verify(token, getSigningKey, opts, (err, decoded) =>
      err ? reject(err) : resolve(decoded)
    )
  );
}

function decodeToken(token) {
  return jwt.decode(token);
}

async function _adminToken() {
  const res = await fetch(`${URL}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "admin-cli",
      grant_type: "password",
      username: process.env.KEYCLOAK_ADMIN || "admin",
      password: process.env.KEYCLOAK_ADMIN_PASSWORD || "admin",
    }),
  });
  if (!res.ok) throw new Error("Keycloak admin token fetch failed");
  return (await res.json()).access_token;
}

// Creates a user in Keycloak and sets their initial password.
// Returns the new user's Keycloak ID, or null if the user already existed.
async function provisionUser(email, password, name = "", role = "") {
  const token = await _adminToken();
  const [firstName, ...rest] = name.split(" ");

  // Step 1 — create user (no credentials in body — set separately for reliability)
  const createRes = await fetch(`${URL}/admin/realms/${REALM}/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      username: email,
      email,
      firstName: firstName || "",
      lastName: rest.join(" ") || "",
      enabled: true,
      emailVerified: true,
      // Require password reset on first login
      requiredActions: ["UPDATE_PASSWORD"],
    }),
  });

  if (createRes.status === 409) return null; // already exists
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    throw new Error(`Keycloak user creation failed (${createRes.status}): ${body}`);
  }

  // Step 2 — extract new user ID from Location header
  const location = createRes.headers.get("location") || "";
  const userId = location.split("/").filter(Boolean).pop();
  if (!userId) throw new Error("Keycloak user created but no Location header returned");

  // Step 3 — set password via dedicated reset-password endpoint (reliable across all KC versions)
  const pwRes = await fetch(`${URL}/admin/realms/${REALM}/users/${userId}/reset-password`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "password", value: password, temporary: true }),
  });
  if (!pwRes.ok) {
    const body = await pwRes.text().catch(() => "");
    throw new Error(`Keycloak set-password failed (${pwRes.status}): ${body}`);
  }

  // Step 4 — assign realm role if provided
  if (role) {
    try {
      // Look up the role object (need its id + name for the role-mapping API)
      const rolesRes = await fetch(`${URL}/admin/realms/${REALM}/roles/${encodeURIComponent(role)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!rolesRes.ok) {
        throw new Error(`Keycloak role "${role}" not found (${rolesRes.status})`);
      }
      const roleObj = await rolesRes.json();
      const assignRes = await fetch(`${URL}/admin/realms/${REALM}/users/${userId}/role-mappings/realm`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify([{ id: roleObj.id, name: roleObj.name }]),
      });
      if (!assignRes.ok) {
        const body = await assignRes.text().catch(() => "");
        throw new Error(`Keycloak role assignment failed (${assignRes.status}): ${body}`);
      }
    } catch (roleErr) {
      log.warn(`⚠️  Keycloak role assignment failed for ${email}:`, roleErr.message);
      // Re-throw so callers know provisioning was incomplete
      throw roleErr;
    }
  }

  return userId;
}

async function resendInitialInvitation(email) {
  const token = await _adminToken();
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const usersRes = await fetch(`${URL}/admin/realms/${REALM}/users?username=${encodeURIComponent(normalizedEmail)}&exact=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!usersRes.ok) throw new Error(`Keycloak user lookup failed (${usersRes.status})`);
  const users = await usersRes.json();
  const user = users.find((candidate) => String(candidate.email || candidate.username || "").toLowerCase() === normalizedEmail);
  if (!user) throw Object.assign(new Error("The organization admin account was not found."), { statusCode: 404 });
  if (!user.enabled || !(user.requiredActions || []).includes("UPDATE_PASSWORD")) {
    throw Object.assign(new Error("The initial invitation can only be resent before the organization admin signs in for the first time."), { statusCode: 409 });
  }

  const tempPassword = require("./cognito").generateCompliantTemporaryPassword();
  const passwordRes = await fetch(`${URL}/admin/realms/${REALM}/users/${user.id}/reset-password`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "password", value: tempPassword, temporary: true }),
  });
  if (!passwordRes.ok) {
    const body = await passwordRes.text().catch(() => "");
    throw new Error(`Keycloak temporary password reset failed (${passwordRes.status}): ${body}`);
  }
  return { tempPassword };
}

module.exports = { verifyToken, decodeToken, provisionUser, resendInitialInvitation };
