'use strict';

const { assertTransactionContext } = require('../../../kernel/transactionContext');
const { normalizePlanTerms, normalizePlanOverrides, applyPlanOverrides } = require('../terms');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');

function rowsOf(value) {
  const result = Array.isArray(value) && value.length === 2 && Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(result) ? result : result?.rows || [];
}
function affectedRows(value) {
  const result = Array.isArray(value) && value.length === 2 && Array.isArray(value[0]) ? value[0] : value;
  return Number(result?.affectedRows ?? result?.rowCount ?? 0);
}
function parseJson(value, label) {
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch (cause) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, `${label} contains invalid JSON.`, { retryable: true, details: { cause: cause.message } });
  }
}
function instant(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError('Stored organization billing terms contain an invalid effective date.');
  return parsed;
}
function toIso(value) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function assertPublishedPlanVersionMatches(tx, record, effectiveAt, canonicalTerms) {
  return tx.query(
    `SELECT id,plan_id,version,status,terms_json,effective_from,effective_to
       FROM billing_plan_versions WHERE plan_id=? AND version=? FOR UPDATE`,
    [record.planVersion.planId, record.planVersion.version],
  ).then((result) => {
    const row = rowsOf(result)[0];
    if (!row) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Referenced billing plan version does not exist.');
    const rowTerms = normalizePlanTerms(parseJson(row.terms_json, 'Published plan terms'));
    const suppliedFrom = instant(record.planVersion.effectiveFrom);
    const storedFrom = instant(row.effective_from);
    const suppliedTo = record.planVersion.effectiveTo == null ? null : instant(record.planVersion.effectiveTo);
    const storedTo = row.effective_to == null ? null : instant(row.effective_to);
    const identityMatches = row.id === record.planVersion.id
      && row.plan_id === record.planVersion.planId
      && Number(row.version) === Number(record.planVersion.version)
      && String(row.status).toLowerCase() === 'published';
    const snapshotMatches = canonicalJson(rowTerms) === canonicalTerms;
    const windowMatches = suppliedFrom === storedFrom && suppliedTo === storedTo;
    const isEffective = effectiveAt >= storedFrom && (storedTo === null || effectiveAt < storedTo);
    if (!identityMatches || !snapshotMatches || !windowMatches || !isEffective) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Referenced plan version is stale, unpublished, or does not match the persisted immutable plan snapshot.', {
        details: { planId: record.planVersion.planId, planVersion: record.planVersion.version },
      });
    }
    return row;
  });
}

function mapRow(row) {
  if (!row) return null;
  const snapshot = parseJson(row.terms_snapshot_json, 'Organization terms snapshot');
  const overrides = normalizePlanOverrides(parseJson(row.override_json, 'Organization terms override') || {});
  if (snapshot?.schemaVersion !== 1 || !snapshot.planVersion || !snapshot.effectiveTerms) {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Organization billing terms snapshot is incomplete.', { retryable: true });
  }
  return Object.freeze({
    id: row.id,
    orgId: row.org_id,
    version: Number(row.version),
    planId: row.plan_id,
    planVersion: Number(row.plan_version),
    effectiveFrom: toIso(row.effective_from),
    effectiveTo: row.effective_to == null ? null : toIso(row.effective_to),
    planSnapshot: snapshot.planVersion,
    effectiveTerms: normalizePlanTerms(snapshot.effectiveTerms),
    overrides,
    changeReason: row.change_reason || null,
    createdBy: row.created_by || null,
    createdAt: toIso(row.created_at),
  });
}

/** Transaction-scoped organization_billing_terms repository. */
function createMysqlOrganizationTermsRepository() {
  async function insertEffectiveTerms(tx, record) {
    assertTransactionContext(tx);
    if (tx.metadata?.orgId !== record.orgId) throw new TypeError('Organization terms orgId must match transaction orgId.');
    // Preserve the global lock order (organization account, then plan and
    // organization terms) even if this method is called by another runner.
    const account = rowsOf(await tx.query(
      'SELECT org_id FROM organization_billing_accounts WHERE org_id=? FOR UPDATE', [record.orgId],
    ))[0];
    if (!account) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Organization billing account does not exist.');
    const planTerms = normalizePlanTerms(record.planVersion.terms);
    const effectiveAt = instant(record.effectiveAt);
    await assertPublishedPlanVersionMatches(tx, record, effectiveAt, canonicalJson(planTerms));
    const overrides = normalizePlanOverrides(record.overrides || {});
    const effectiveTerms = applyPlanOverrides(planTerms, overrides);
    const snapshot = {
      schemaVersion: 1,
      planVersion: {
        id: record.planVersion.id,
        planId: record.planVersion.planId,
        version: record.planVersion.version,
        status: record.planVersion.status,
        effectiveFrom: record.planVersion.effectiveFrom,
        effectiveTo: record.planVersion.effectiveTo,
        terms: planTerms,
      },
      effectiveTerms,
    };
    const start = effectiveAt;

    // The org row lock above also serializes empty-range inserts, where an
    // organization_terms range query alone cannot prevent a phantom version.
    const versions = rowsOf(await tx.query(
      `SELECT id,version,effective_from,effective_to FROM organization_billing_terms
        WHERE org_id=? ORDER BY version FOR UPDATE`, [record.orgId],
    ));
    const future = versions.filter((row) => instant(row.effective_from) >= start);
    if (future.length) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'An organization terms version already starts at or after this effective date.', {
        details: { orgId: record.orgId, effectiveAt: record.effectiveAt, conflictingVersion: Number(future[0].version) },
      });
    }
    const current = versions.filter((row) => instant(row.effective_from) < start && (row.effective_to == null || instant(row.effective_to) > start));
    if (current.length > 1) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Overlapping organization billing terms already exist.', { retryable: true, details: { orgId: record.orgId } });
    }
    const version = versions.reduce((max, row) => Math.max(max, Number(row.version)), 0) + 1;
    if (current[0]) {
      const result = await tx.query(
        `UPDATE organization_billing_terms SET effective_to=?
          WHERE org_id=? AND id=? AND (effective_to IS NULL OR effective_to>?)`,
        [record.effectiveAt, record.orgId, current[0].id, record.effectiveAt],
      );
      if (affectedRows(result) !== 1) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_CONCURRENCY, 'Prior organization terms changed before the effective boundary was applied.', { retryable: true });
      }
    }
    await tx.query(
      `INSERT INTO organization_billing_terms
         (id,org_id,version,plan_id,plan_version,effective_from,effective_to,terms_snapshot_json,override_json,change_reason,created_by,created_at)
       VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?)`,
      [record.id, record.orgId, version, record.planVersion.planId, record.planVersion.version, record.effectiveAt,
        JSON.stringify(snapshot), JSON.stringify(overrides), record.changeReason || null, record.actorId, record.now],
    );
    return Object.freeze({
      id: record.id,
      orgId: record.orgId,
      version,
      planId: record.planVersion.planId,
      planVersion: record.planVersion.version,
      effectiveFrom: record.effectiveAt,
      effectiveTo: null,
      planSnapshot: snapshot.planVersion,
      effectiveTerms,
      overrides,
      changeReason: record.changeReason || null,
      createdBy: record.actorId,
      createdAt: record.now,
    });
  }

  async function getEffectiveTerms(tx, { orgId, at }) {
    assertTransactionContext(tx);
    if (tx.metadata?.orgId !== orgId) throw new TypeError('Organization terms orgId must match transaction orgId.');
    const rows = rowsOf(await tx.query(
      `SELECT id,org_id,version,plan_id,plan_version,effective_from,effective_to,terms_snapshot_json,override_json,change_reason,created_by,created_at
         FROM organization_billing_terms
        WHERE org_id=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>?)
        ORDER BY effective_from DESC,version DESC LIMIT 2`, [orgId, at, at],
    ));
    if (rows.length > 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Overlapping effective organization terms detected.', { retryable: true, details: { orgId, at } });
    return mapRow(rows[0]);
  }

  return Object.freeze({ insertEffectiveTerms, getEffectiveTerms });
}

module.exports = { createMysqlOrganizationTermsRepository, mapOrganizationTermsRow: mapRow };
