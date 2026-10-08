'use strict';

const { assertTransactionContext } = require('../../../kernel/transactionContext');
const { validateId } = require('../../../kernel/scope');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');
const { normalizeRules, checksum } = require('../domain');

function rowsOf(value) {
  const result = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(result) ? result : result?.rows || [];
}
function affectedRows(value) {
  const result = Array.isArray(value) && value.length === 2 ? value[0] : value;
  return Number(result?.affectedRows ?? result?.rowCount ?? 0);
}
function parseJson(value, label) {
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch (cause) { throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, `${label} contains invalid JSON.`, { retryable: true, details: { cause: cause.message } }); }
}
function assertOrg(tx, orgId) {
  assertTransactionContext(tx);
  validateId(orgId, 'orgId');
  if (tx.metadata?.orgId !== orgId) throw new TypeError('Allocation organization must match transaction organization.');
}
function mapRule(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id, orgId: row.org_id, grantKind: row.grant_kind, version: Number(row.version),
    status: row.status, schemaVersion: Number(row.rules_schema_version),
    rules: parseJson(row.rules_json, 'Allocation rule set'), checksum: row.rules_checksum,
    effectiveAt: row.effective_at, createdBy: row.created_by, createdAt: row.created_at,
  });
}
function mapRun(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id, orgId: row.org_id, grantId: row.grant_id, periodId: row.period_id,
    ruleVersionId: row.rule_version_id, runKey: row.run_key, runType: row.run_type,
    status: row.status, manifestSchemaVersion: Number(row.manifest_schema_version),
    manifest: parseJson(row.manifest_json, 'Allocation run manifest'), manifestChecksum: row.manifest_checksum,
    totalUnits: String(row.total_units), appliedUnits: String(row.applied_units), version: Number(row.version),
    attemptCount: Number(row.attempt_count), lastErrorCode: row.last_error_code,
    completedAt: row.completed_at, createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

function createMysqlAllocationRepository({ idSource, clock } = {}) {
  if (typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function') throw new TypeError('Allocation repository requires an ID source and clock.');

  async function getWorkspaces(tx, { orgId, workspaceIds }) {
    assertOrg(tx, orgId);
    if (!Array.isArray(workspaceIds) || workspaceIds.length > 1000) throw new TypeError('workspaceIds must contain at most 1000 IDs.');
    if (!workspaceIds.length) return [];
    workspaceIds.forEach((id) => validateId(id, 'workspaceId'));
    const placeholders = workspaceIds.map(() => '?').join(',');
    const rows = rowsOf(await tx.query(
      `SELECT id,org_id,name,industry,status FROM workspaces WHERE org_id=? AND id IN (${placeholders}) ORDER BY id FOR UPDATE`,
      [orgId, ...workspaceIds],
    ));
    if (rows.length !== new Set(workspaceIds).size) {
      const found = new Set(rows.map((row) => row.id));
      const missing = workspaceIds.filter((id) => !found.has(id));
      throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'An allocation rule references a workspace outside this organization.', { details: { workspaceIds: missing } });
    }
    return rows.map((row) => Object.freeze({ id: row.id, orgId: row.org_id, name: row.name, industry: row.industry, status: row.status }));
  }

  async function getWorkspace(tx, { orgId, workspaceId }) {
    assertOrg(tx, orgId);
    const row = rowsOf(await tx.query(
      `SELECT id,org_id,name,industry,status FROM workspaces WHERE org_id=? AND id=? FOR UPDATE`, [orgId, validateId(workspaceId, 'workspaceId')],
    ))[0];
    return row ? Object.freeze({ id: row.id, orgId: row.org_id, name: row.name, industry: row.industry, status: row.status }) : null;
  }

  async function getRuleVersion(tx, { orgId, grantKind, version, at = clock.now() }) {
    assertOrg(tx, orgId);
    const params = [orgId, grantKind];
    const versionClause = version === undefined ? `AND status='active' AND (effective_at IS NULL OR effective_at<=?)` : 'AND version=?';
    params.push(version === undefined ? at : version);
    const row = rowsOf(await tx.query(
      `SELECT id,org_id,grant_kind,version,status,rules_schema_version,rules_json,rules_checksum,effective_at,created_by,created_at
         FROM billing_allocation_rule_versions WHERE org_id=? AND grant_kind=? ${versionClause}
        ORDER BY version DESC LIMIT 1 FOR UPDATE`, params,
    ))[0];
    return mapRule(row);
  }

  async function saveRuleVersion(tx, record) {
    assertOrg(tx, record.orgId);
    const existing = rowsOf(await tx.query(
      `SELECT COALESCE(MAX(version),0) AS current_version FROM billing_allocation_rule_versions
        WHERE org_id=? AND grant_kind=?`, [record.orgId, record.grantKind],
    ))[0];
    const currentVersion = Number(existing?.current_version || 0);
    if (currentVersion !== record.expectedVersion || record.version !== currentVersion + 1) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Allocation rule version is stale.', { details: { expectedVersion: record.expectedVersion, actualVersion: currentVersion, requestedVersion: record.version } });
    }
    const rules = normalizeRules(record.rules, record.grantKind);
    const digest = checksum(rules);
    const id = record.id || idSource.newId('billing-allocation-rule');
    await tx.query(
      `INSERT INTO billing_allocation_rule_versions
        (id,org_id,grant_kind,version,status,rules_schema_version,rules_json,rules_checksum,effective_at,created_by,created_at)
       VALUES (?,?,?,?,'active',1,?,?,?,?,?)`,
      [id, record.orgId, record.grantKind, record.version, JSON.stringify(rules), digest, record.effectiveAt || clock.now(), record.actorId || null, record.now || clock.now()],
    );
    return Object.freeze({ id, orgId: record.orgId, grantKind: record.grantKind, version: record.version, status: 'active', schemaVersion: 1, rules, checksum: digest, effectiveAt: record.effectiveAt || clock.now(), createdBy: record.actorId || null, createdAt: record.now || clock.now() });
  }

  async function getRunForUpdate(tx, { orgId, runId, grantId, runKey }) {
    assertOrg(tx, orgId);
    let predicate;
    let params;
    if (runId) { predicate = 'id=?'; params = [orgId, validateId(runId, 'runId')]; }
    else { predicate = 'grant_id=? AND run_key=?'; params = [orgId, validateId(grantId, 'grantId'), String(runKey)]; }
    const row = rowsOf(await tx.query(
      `SELECT id,org_id,grant_id,period_id,rule_version_id,run_key,run_type,status,manifest_schema_version,manifest_json,
              manifest_checksum,total_units,applied_units,version,attempt_count,last_error_code,completed_at,created_at,updated_at
         FROM billing_allocation_runs WHERE org_id=? AND ${predicate} FOR UPDATE`, params,
    ))[0];
    return mapRun(row);
  }

  async function getAutomaticRunForGrant(tx, { orgId, grantId }) {
    assertOrg(tx, orgId);
    const row = rowsOf(await tx.query(
      `SELECT id,org_id,grant_id,period_id,rule_version_id,run_key,run_type,status,manifest_schema_version,manifest_json,
              manifest_checksum,total_units,applied_units,version,attempt_count,last_error_code,completed_at,created_at,updated_at
         FROM billing_allocation_runs WHERE org_id=? AND grant_id=? AND run_type='automatic' LIMIT 1 FOR UPDATE`,
      [orgId, validateId(grantId, 'grantId')],
    ))[0];
    return mapRun(row);
  }

  async function createRun(tx, record) {
    assertOrg(tx, record.orgId);
    const prior = await getRunForUpdate(tx, { orgId: record.orgId, grantId: record.grantId, runKey: record.runKey });
    const digest = checksum(record.manifest);
    if (prior) {
      if (prior.manifestChecksum !== digest || prior.ruleVersionId !== (record.ruleVersionId || null)) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, 'Allocation run key already exists with different rules or manifest.');
      }
      return prior;
    }
    const id = record.id || idSource.newId('billing-allocation-run');
    const now = record.now || clock.now();
    await tx.query(
      `INSERT INTO billing_allocation_runs
        (id,org_id,grant_id,period_id,rule_version_id,run_key,run_type,status,manifest_schema_version,manifest_json,manifest_checksum,
         total_units,applied_units,version,attempt_count,last_error_code,completed_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,0,0,NULL,?,?,?)`,
      [id, record.orgId, record.grantId, record.periodId || null, record.ruleVersionId || null, record.runKey,
        record.runType, record.status, JSON.stringify(record.manifest), digest, record.totalUnits, record.appliedUnits || '0',
        record.completedAt || null, now, now],
    );
    return getRunForUpdate(tx, { orgId: record.orgId, runId: id });
  }

  async function updateRun(tx, { orgId, runId, expectedVersion, status, manifest, totalUnits, appliedUnits, completedAt = null, lastErrorCode = null, now = clock.now() }) {
    assertOrg(tx, orgId);
    const digest = checksum(manifest);
    const changed = await tx.query(
      `UPDATE billing_allocation_runs
          SET status=?,manifest_json=?,manifest_checksum=?,total_units=?,applied_units=?,version=version+1,
              attempt_count=attempt_count+1,last_error_code=?,completed_at=?,updated_at=?
        WHERE org_id=? AND id=? AND version=?`,
      [status, JSON.stringify(manifest), digest, totalUnits, appliedUnits, lastErrorCode, completedAt, now, orgId, runId, expectedVersion],
    );
    if (affectedRows(changed) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Allocation run changed concurrently.');
    return getRunForUpdate(tx, { orgId, runId });
  }

  return Object.freeze({ getWorkspaces, getWorkspace, getRuleVersion, saveRuleVersion, getRunForUpdate, getAutomaticRunForGrant, createRun, updateRun });
}

module.exports = { createMysqlAllocationRepository, mapAllocationRule: mapRule, mapAllocationRun: mapRun };
