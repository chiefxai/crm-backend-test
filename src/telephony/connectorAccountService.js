"use strict";

const crypto = require("crypto");
const db = require("../db/repository");
const registry = require("./registry");
const { encryptJson, decryptJson } = require("../security/channelCredentials");

const ACCOUNT_SELECT = `id,provider_key,display_name,owner_type,owner_org_id,provider_account_id,
  credential_schema_version,credential_version,public_config_json,status,last_validated_at,last_validation_status,
  last_validation_error,created_by,updated_by,created_at,updated_at`;

function serviceError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isAccountProvider(provider) {
  const capabilities = provider?.capabilities || {};
  return (provider?.credentialSchema || []).length > 0
    || capabilities.inbound === true
    || capabilities.outbound === true
    || capabilities.numberProvisioning === true
    || capabilities.numberDiscovery === true
    || capabilities.numberPurchase === true;
}

function listSupportedProviders() {
  return registry.listProviderDefinitions().filter(isAccountProvider);
}

function getProvider(providerKey) {
  if (typeof providerKey !== "string" || !providerKey.trim()) throw serviceError("providerKey is required");
  const definition = listSupportedProviders().find((item) => item.providerKey === providerKey);
  if (!definition) throw serviceError("Unsupported telephony provider", 400);
  return definition;
}

function validateCredentials(provider, incoming, previous = null, { partial = false } = {}) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    throw serviceError("credentials must be an object");
  }
  const allowed = new Set(provider.credentialSchema.map((field) => field.key));
  for (const key of Object.keys(incoming)) {
    if (!allowed.has(key)) throw serviceError(`Unsupported credential field: ${key}`);
  }
  const merged = { ...(previous || {}) };
  for (const field of provider.credentialSchema) {
    const value = incoming[field.key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || value.trim() !== value) {
      throw serviceError(`Credential field ${field.key} must be a trimmed string`);
    }
    merged[field.key] = value;
  }
  for (const field of provider.credentialSchema) {
    if (field.required && (typeof merged[field.key] !== "string" || !merged[field.key])) {
      throw serviceError(partial ? `Credential field ${field.key} is required` : `Missing required credential field: ${field.key}`);
    }
  }
  return merged;
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function toPublic(row) {
  return {
    id: row.id,
    providerKey: row.provider_key,
    displayName: row.display_name,
    ownerType: row.owner_type,
    ownerOrgId: row.owner_org_id || null,
    providerAccountId: row.provider_account_id || null,
    credentialSchemaVersion: row.credential_schema_version,
    credentialVersion: Number(row.credential_version) || 1,
    credentialFieldsConfigured: true,
    publicConfig: parseJson(row.public_config_json),
    status: row.status,
    lastValidatedAt: row.last_validated_at || null,
    lastValidationStatus: row.last_validation_status || null,
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateOwner(owner) {
  if (owner?.ownerType === "platform" && !owner.ownerOrgId) return { ownerType: "platform", ownerOrgId: null };
  if (owner?.ownerType === "organization" && typeof owner.ownerOrgId === "string" && owner.ownerOrgId) {
    return { ownerType: "organization", ownerOrgId: owner.ownerOrgId };
  }
  throw serviceError("Invalid connector account owner", 400);
}

function validateInputKeys(input, allowedKeys) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw serviceError("Request body must be an object");
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw serviceError(`Unsupported connector account field: ${unknown}`);
}

async function listAccounts(owner) {
  const scope = validateOwner(owner);
  const { rows } = await db.pool.query(
    `SELECT ${ACCOUNT_SELECT} FROM telephony_connector_accounts
     WHERE owner_type=? AND ((owner_org_id IS NULL AND ? IS NULL) OR owner_org_id=?)
     ORDER BY created_at DESC`,
    [scope.ownerType, scope.ownerOrgId, scope.ownerOrgId]
  );
  return rows.map(toPublic);
}

async function getAccount(id, owner) {
  const scope = validateOwner(owner);
  const { rows } = await db.pool.query(
    `SELECT ${ACCOUNT_SELECT},credential_ciphertext FROM telephony_connector_accounts
     WHERE id=? AND owner_type=? AND ((owner_org_id IS NULL AND ? IS NULL) OR owner_org_id=?) LIMIT 1`,
    [id, scope.ownerType, scope.ownerOrgId, scope.ownerOrgId]
  );
  return rows[0] || null;
}

async function createAccount(owner, input, actorId) {
  const scope = validateOwner(owner);
  validateInputKeys(input, ["providerKey", "displayName", "providerAccountId", "credentials"]);
  const provider = getProvider(input?.providerKey);
  const displayName = typeof input?.displayName === "string" ? input.displayName.trim() : "";
  if (!displayName || displayName.length > 191) throw serviceError("displayName is required and must be 191 characters or fewer");
  if (input.providerAccountId != null && typeof input.providerAccountId !== "string") {
    throw serviceError("providerAccountId must be a string");
  }
  const providerAccountId = input.providerAccountId == null || input.providerAccountId === ""
    ? null : input.providerAccountId.trim();
  if (providerAccountId && providerAccountId.length > 191) throw serviceError("providerAccountId must be 191 characters or fewer");
  const credentials = validateCredentials(provider, input.credentials);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const ciphertext = encryptJson(credentials);
  try {
    await db.pool.query(
      `INSERT INTO telephony_connector_accounts
       (id,provider_key,display_name,owner_type,owner_org_id,provider_account_id,credential_ciphertext,
        credential_schema_version,public_config_json,status,created_by,updated_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,1,NULL,'active',?,?,?,?)`,
      [id, provider.providerKey, displayName, scope.ownerType, scope.ownerOrgId, providerAccountId, ciphertext, actorId || null, actorId || null, now, now]
    );
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") throw serviceError("A connector for this provider account already exists in this ownership scope", 409);
    throw error;
  }
  const row = await getAccount(id, scope);
  return toPublic(row);
}

async function updateAccount(id, owner, input, actorId) {
  const scope = validateOwner(owner);
  validateInputKeys(input, ["displayName", "providerAccountId", "credentials", "status"]);
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    const { rows } = await connection.query(
      `SELECT ${ACCOUNT_SELECT},credential_ciphertext FROM telephony_connector_accounts
       WHERE id=? AND owner_type=? AND ((owner_org_id IS NULL AND ? IS NULL) OR owner_org_id=?) LIMIT 1 FOR UPDATE`,
      [id, scope.ownerType, scope.ownerOrgId, scope.ownerOrgId]
    );
    const existing = rows[0];
    if (!existing) throw serviceError("Connector account not found", 404);
    const provider = getProvider(existing.provider_key);
    const hasCredentials = Object.prototype.hasOwnProperty.call(input || {}, "credentials");
    const existingCredentials = hasCredentials ? decryptJson(existing.credential_ciphertext) : null;
    const credentials = hasCredentials
      ? validateCredentials(provider, input.credentials, existingCredentials, { partial: true })
      : null;
    const credentialsChanged = Boolean(credentials)
      && JSON.stringify(credentials) !== JSON.stringify(existingCredentials);
    if (credentialsChanged) {
      const { rows: activeRoutes } = await connection.query(
        `SELECT id FROM telephony_call_routes
         WHERE connector_account_id=? AND status IN ('starting','active') LIMIT 1`, [id]
      );
      if (activeRoutes[0]) throw serviceError("Cannot rotate credentials while calls are active on this connector", 409);
    }
    if (input?.displayName !== undefined && typeof input.displayName !== "string") throw serviceError("displayName must be a string");
    const displayName = input?.displayName === undefined ? existing.display_name : input.displayName.trim();
    if (!displayName || displayName.length > 191) throw serviceError("displayName is required and must be 191 characters or fewer");
    if (input?.providerAccountId !== undefined && input.providerAccountId != null && typeof input.providerAccountId !== "string") {
      throw serviceError("providerAccountId must be a string");
    }
    const providerAccountId = input?.providerAccountId === undefined
      ? existing.provider_account_id
      : (input.providerAccountId == null || input.providerAccountId === "" ? null : input.providerAccountId.trim());
    if (providerAccountId && providerAccountId.length > 191) throw serviceError("providerAccountId must be 191 characters or fewer");
    const status = input?.status === undefined ? existing.status : input.status;
    if (!["active", "disabled"].includes(status)) throw serviceError("status must be active or disabled");
    const now = new Date().toISOString();
    const credentialVersion = (Number(existing.credential_version) || 1) + (credentialsChanged ? 1 : 0);
    await connection.query(
      `UPDATE telephony_connector_accounts SET display_name=?,provider_account_id=?,credential_ciphertext=?,credential_version=?,status=?,updated_by=?,updated_at=?
       WHERE id=? AND owner_type=? AND ((owner_org_id IS NULL AND ? IS NULL) OR owner_org_id=?)`,
      [displayName, providerAccountId, credentialsChanged ? encryptJson(credentials) : existing.credential_ciphertext, credentialVersion, status,
        actorId || null, now, id, scope.ownerType, scope.ownerOrgId, scope.ownerOrgId]
    );
    await connection.query("COMMIT");
  } catch (error) {
    try { await connection.query("ROLLBACK"); } catch (_) { /* preserve original error */ }
    if (error.code === "ER_DUP_ENTRY") throw serviceError("A connector for this provider account already exists in this ownership scope", 409);
    throw error;
  } finally {
    connection.release();
  }
  const row = await getAccount(id, scope);
  return toPublic(row);
}

async function disableAccount(id, owner, actorId) {
  return updateAccount(id, owner, {}, actorId).then(async (account) => {
    if (account.status === "disabled") return account;
    return updateAccount(id, owner, { status: "disabled" }, actorId);
  });
}

module.exports = { listSupportedProviders, getProvider, validateCredentials, toPublic, listAccounts, getAccount, createAccount, updateAccount, disableAccount };
