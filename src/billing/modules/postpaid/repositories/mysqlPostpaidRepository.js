'use strict';

const { assertTransactionContext } = require('../../../kernel/transactionContext');
const { validateId } = require('../../../kernel/scope');
const { validateAmount } = require('../../../kernel/amount');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');

function rowsOf(value) { const rows = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value; return Array.isArray(rows) ? rows : rows?.rows || []; }
function affected(value) { const result = Array.isArray(value) && value.length === 2 && !Array.isArray(value[0]) ? value[0] : value; return Number(result?.affectedRows ?? result?.rowCount ?? 0); }
function stable(value) { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function assertOrg(tx, orgId) {
  assertTransactionContext(tx); validateId(orgId, 'orgId');
  if (tx.metadata?.orgId !== orgId) throw new TypeError('Postpaid organization must match the transaction organization.');
}
function mapPolicy(row) {
  if (!row) return null;
  const enabled = Boolean(Number(row.enabled));
  return Object.freeze({ id: row.id, orgId: row.org_id, workspaceId: row.workspace_id,
    enabled, mode: enabled ? (row.limit_units == null ? 'unlimited' : 'limited') : 'disabled',
    cycleLimit: row.limit_units == null ? null : Object.freeze({ units: String(row.limit_units), asset: row.asset, scale: Number(row.scale) }),
    asset: row.asset, scale: Number(row.scale), effectiveAt: new Date(row.effective_at).toISOString(), version: Number(row.version) });
}

function createMysqlPostpaidRepository({ idSource, clock } = {}) {
  if (typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function') throw new TypeError('Postpaid repository requires ID source and clock.');

  async function getWorkspacePolicyForUpdate(tx, { orgId, workspaceId }) {
    assertOrg(tx, orgId);
    return mapPolicy(rowsOf(await tx.query(`SELECT id,org_id,workspace_id,enabled,limit_units,asset,scale,effective_at,version
      FROM billing_postpaid_accounts WHERE org_id=? AND scope_type='workspace' AND scope_owner_id=? FOR UPDATE`,
    [orgId, validateId(workspaceId, 'workspaceId')]))[0]);
  }

  async function setOrganizationFallbackMode(tx, { orgId, fallbackMode, expectedVersion }) {
    assertOrg(tx, orgId);
    const result = await tx.query(`UPDATE organization_billing_accounts SET fallback_mode=?,enforcement_version=enforcement_version+1,updated_at=?
      WHERE org_id=? AND enforcement_version=?`, [fallbackMode, clock.now(), orgId, expectedVersion]);
    if (affected(result) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Organization funding mode changed concurrently.');
    const row = rowsOf(await tx.query('SELECT org_id,fallback_mode,enforcement_version FROM organization_billing_accounts WHERE org_id=? FOR UPDATE', [orgId]))[0];
    return Object.freeze({ orgId, fallbackMode: row.fallback_mode, version: Number(row.enforcement_version) });
  }

  async function setWorkspacePolicy(tx, { orgId, workspaceId, policy, asset, scale, effectiveAt, expectedVersion }) {
    assertOrg(tx, orgId);
    validateId(workspaceId, 'workspaceId');
    const prior = await getWorkspacePolicyForUpdate(tx, { orgId, workspaceId });
    const limit = policy.mode === 'limited' ? validateAmount(policy.cycleLimit) : null;
    if (limit && (limit.asset !== asset || limit.scale !== scale)) throw new BillingDomainError(DOMAIN_ERROR_CODES.MIXED_ASSET, 'Postpaid limit asset or scale does not match billing terms.');
    if ((prior?.version || 0) !== expectedVersion) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Workspace postpaid policy version is stale.', { details: { expectedVersion, actualVersion: prior?.version || 0 } });
    const id = prior?.id || idSource.newId('billing-postpaid-policy');
    const now = clock.now();
    if (prior) {
      const result = await tx.query(`UPDATE billing_postpaid_accounts SET enabled=?,limit_units=?,asset=?,scale=?,effective_at=?,version=version+1,updated_at=?
        WHERE org_id=? AND id=? AND version=?`, [policy.mode === 'disabled' ? 0 : 1, limit?.units ?? null, asset, scale, effectiveAt, now, orgId, id, expectedVersion]);
      if (affected(result) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Workspace postpaid policy changed concurrently.');
    } else {
      await tx.query(`INSERT INTO billing_postpaid_accounts
        (id,org_id,scope_type,scope_owner_id,workspace_id,enabled,limit_units,asset,scale,effective_at,version,created_at,updated_at)
        VALUES (?,?,'workspace',?,?,?,?,?,?,?,1,?,?)`,
      [id, orgId, workspaceId, workspaceId, policy.mode === 'disabled' ? 0 : 1, limit?.units ?? null, asset, scale, effectiveAt, now, now]);
    }
    return getWorkspacePolicyForUpdate(tx, { orgId, workspaceId });
  }

  async function lockTotal(tx, { orgId, periodId, scopeType, scopeOwnerId, workspaceId, asset, scale }) {
    await tx.query(`INSERT IGNORE INTO billing_postpaid_period_totals
      (id,org_id,scope_type,scope_owner_id,workspace_id,period_id,settled_units,reserved_units,limit_units,asset,scale,version,updated_at)
      VALUES (?,?,?,?,?,?,0,0,NULL,?,?,1,?)`,
    [idSource.newId('billing-postpaid-total'), orgId, scopeType, scopeOwnerId, workspaceId, periodId, asset, scale, clock.now()]);
    const row = rowsOf(await tx.query(`SELECT id,settled_units,reserved_units,asset,scale,version FROM billing_postpaid_period_totals
      WHERE org_id=? AND period_id=? AND scope_type=? AND scope_owner_id=? FOR UPDATE`,
    [orgId, periodId, scopeType, scopeOwnerId]))[0];
    if (!row) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Could not lock postpaid period total.', { retryable: true });
    return row;
  }

  async function reserveExposure(tx, { orgId, workspaceId, periodId, amount, workspaceLimit, organizationLimit }) {
    assertOrg(tx, orgId); validateId(periodId, 'periodId');
    const normalized = validateAmount(amount);
    const workspace = await lockTotal(tx, { orgId, periodId, scopeType: 'workspace', scopeOwnerId: workspaceId, workspaceId, asset: normalized.asset, scale: normalized.scale });
    const organization = organizationLimit ? await lockTotal(tx, { orgId, periodId, scopeType: 'organization', scopeOwnerId: orgId, workspaceId: null, asset: normalized.asset, scale: normalized.scale }) : null;
    const units = BigInt(normalized.units);
    if (workspaceLimit) {
      const cap = BigInt(validateAmount(workspaceLimit).units);
      if (BigInt(workspace.settled_units) + BigInt(workspace.reserved_units) + units > cap) throw new BillingDomainError(DOMAIN_ERROR_CODES.POSTPAID_LIMIT_REACHED, 'Workspace postpaid cycle limit would be exceeded.', { details: { capUnits: cap.toString(), usedUnits: String(workspace.settled_units), heldUnits: String(workspace.reserved_units), requestedUnits: normalized.units, periodId } });
    }
    if (organization) {
      const cap = BigInt(validateAmount(organizationLimit).units);
      const exposure = rowsOf(await tx.query(`SELECT COALESCE(SUM(settled_units),0) AS settled_units,COALESCE(SUM(reserved_units),0) AS reserved_units
        FROM billing_postpaid_period_totals WHERE org_id=? AND scope_type='organization' AND scope_owner_id=? AND asset=? AND scale=?`,
      [orgId, orgId, normalized.asset, normalized.scale]))[0] || {};
      const settledUnits = BigInt(exposure.settled_units || '0');
      const reservedUnits = BigInt(exposure.reserved_units || '0');
      if (settledUnits + reservedUnits + units > cap) throw new BillingDomainError(DOMAIN_ERROR_CODES.POSTPAID_LIMIT_REACHED, 'Organization postpaid outstanding exposure limit would be exceeded.', { details: { capUnits: cap.toString(), usedUnits: settledUnits.toString(), heldUnits: reservedUnits.toString(), requestedUnits: normalized.units, periodId } });
    }
    await tx.query(`UPDATE billing_postpaid_period_totals SET reserved_units=reserved_units+?,version=version+1,updated_at=? WHERE org_id=? AND id=?`, [normalized.units, clock.now(), orgId, workspace.id]);
    if (organization) await tx.query(`UPDATE billing_postpaid_period_totals SET reserved_units=reserved_units+?,version=version+1,updated_at=? WHERE org_id=? AND id=?`, [normalized.units, clock.now(), orgId, organization.id]);
    return Object.freeze({ workspaceReservedUnits: (BigInt(workspace.reserved_units) + units).toString(), organizationReservedUnits: organization ? (BigInt(organization.reserved_units) + units).toString() : null });
  }

  async function releaseExposure(tx, { orgId, workspaceId, periodId, amount, organizationLimitApplied = false }) {
    assertOrg(tx, orgId); const normalized = validateAmount(amount);
    const workspace = await lockTotal(tx, { orgId, periodId, scopeType: 'workspace', scopeOwnerId: workspaceId, workspaceId, asset: normalized.asset, scale: normalized.scale });
    if (BigInt(workspace.reserved_units) < BigInt(normalized.units)) throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Postpaid reserved exposure is lower than the reservation release.');
    const organization = organizationLimitApplied ? await lockTotal(tx, { orgId, periodId, scopeType: 'organization', scopeOwnerId: orgId, workspaceId: null, asset: normalized.asset, scale: normalized.scale }) : null;
    if (organization && BigInt(organization.reserved_units) < BigInt(normalized.units)) throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Organization postpaid exposure is lower than the reservation release.');
    const now = clock.now();
    await tx.query('UPDATE billing_postpaid_period_totals SET reserved_units=reserved_units-?,version=version+1,updated_at=? WHERE org_id=? AND id=?', [normalized.units, now, orgId, workspace.id]);
    if (organization) await tx.query('UPDATE billing_postpaid_period_totals SET reserved_units=reserved_units-?,version=version+1,updated_at=? WHERE org_id=? AND id=?', [normalized.units, now, orgId, organization.id]);
  }

  async function settleReservedExposure(tx, { orgId, workspaceId, periodId, amount, organizationLimitApplied = false }) {
    assertOrg(tx, orgId); const normalized = validateAmount(amount);
    const workspace = await lockTotal(tx, { orgId, periodId, scopeType: 'workspace', scopeOwnerId: workspaceId, workspaceId, asset: normalized.asset, scale: normalized.scale });
    if (BigInt(workspace.reserved_units) < BigInt(normalized.units)) throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Postpaid held exposure is lower than the usage settlement.');
    const organization = organizationLimitApplied ? await lockTotal(tx, { orgId, periodId, scopeType: 'organization', scopeOwnerId: orgId, workspaceId: null, asset: normalized.asset, scale: normalized.scale }) : null;
    if (organization && BigInt(organization.reserved_units) < BigInt(normalized.units)) throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Organization held exposure is lower than the usage settlement.');
    const now = clock.now();
    await tx.query('UPDATE billing_postpaid_period_totals SET reserved_units=reserved_units-?,settled_units=settled_units+?,version=version+1,updated_at=? WHERE org_id=? AND id=?', [normalized.units, normalized.units, now, orgId, workspace.id]);
    if (organization) await tx.query('UPDATE billing_postpaid_period_totals SET reserved_units=reserved_units-?,settled_units=settled_units+?,version=version+1,updated_at=? WHERE org_id=? AND id=?', [normalized.units, normalized.units, now, orgId, organization.id]);
  }

  async function recordDebtJournal(tx, { orgId, workspaceId, periodId, reservationId, operationId, entryKey, entryType, amount, occurredAt, actorId, metadata, reversalOfId = null }) {
    assertOrg(tx, orgId); const normalized = validateAmount(amount);
    const prior = rowsOf(await tx.query(`SELECT id,entry_type,amount_units,asset,scale,metadata_json FROM billing_postpaid_journals WHERE org_id=? AND entry_key=? FOR UPDATE`, [orgId, entryKey]))[0];
    const metadataJson = JSON.stringify(metadata || {});
    if (prior) {
      if (prior.entry_type !== entryType || String(prior.amount_units) !== normalized.units || prior.asset !== normalized.asset || Number(prior.scale) !== normalized.scale || stable(typeof prior.metadata_json === 'string' ? JSON.parse(prior.metadata_json) : prior.metadata_json || {}) !== stable(metadata || {})) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, 'Postpaid journal entry key already contains different content.');
      }
      return Object.freeze({ id: prior.id, duplicate: true });
    }
    const id = idSource.newId('billing-postpaid-journal');
    await tx.query(`INSERT INTO billing_postpaid_journals
      (id,org_id,workspace_id,period_id,reservation_id,operation_id,entry_key,entry_type,amount_units,asset,scale,occurred_at,actor_id,reason_code,reversal_of_id,metadata_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, orgId, workspaceId, periodId, reservationId || null, operationId, entryKey, entryType, normalized.units, normalized.asset, normalized.scale, occurredAt, actorId || null, null, reversalOfId, metadataJson, clock.now()]);
    return Object.freeze({ id, duplicate: false });
  }

  async function reverseSettledExposure(tx, { orgId, workspaceId, periodId, amount, organizationLimitApplied = false }) {
    assertOrg(tx, orgId); const normalized = validateAmount(amount);
    const workspace = await lockTotal(tx, { orgId, periodId, scopeType: 'workspace', scopeOwnerId: workspaceId, workspaceId, asset: normalized.asset, scale: normalized.scale });
    const organization = organizationLimitApplied ? await lockTotal(tx, { orgId, periodId, scopeType: 'organization', scopeOwnerId: orgId, workspaceId: null, asset: normalized.asset, scale: normalized.scale }) : null;
    const requested = BigInt(normalized.units);
    const workspaceSettled = BigInt(workspace.settled_units);
    const organizationSettled = organization ? BigInt(organization.settled_units) : requested;
    const reduction = [requested, workspaceSettled, organizationSettled].reduce((smallest, value) => value < smallest ? value : smallest);
    if (reduction <= 0n) return Object.freeze({ reducedUnits: '0', paidCreditUnits: requested.toString() });
    const now = clock.now();
    await tx.query('UPDATE billing_postpaid_period_totals SET settled_units=settled_units-?,version=version+1,updated_at=? WHERE org_id=? AND id=?', [reduction.toString(), now, orgId, workspace.id]);
    if (organization) await tx.query('UPDATE billing_postpaid_period_totals SET settled_units=settled_units-?,version=version+1,updated_at=? WHERE org_id=? AND id=?', [reduction.toString(), now, orgId, organization.id]);
    return Object.freeze({ reducedUnits: reduction.toString(), paidCreditUnits: (requested - reduction).toString() });
  }

  async function getExposure(tx, { orgId, workspaceId, periodId, asset, scale }) {
    assertOrg(tx, orgId); const normalized = validateAmount({ asset, units: '0', scale });
    const ws = rowsOf(await tx.query(`SELECT settled_units,reserved_units FROM billing_postpaid_period_totals WHERE org_id=? AND period_id=? AND scope_type='workspace' AND scope_owner_id=? AND asset=? AND scale=?`, [orgId, periodId, workspaceId, normalized.asset, normalized.scale]))[0];
    const org = rowsOf(await tx.query(`SELECT COALESCE(SUM(settled_units),0) AS settled_units,COALESCE(SUM(reserved_units),0) AS reserved_units FROM billing_postpaid_period_totals WHERE org_id=? AND scope_type='organization' AND scope_owner_id=? AND asset=? AND scale=?`, [orgId, orgId, normalized.asset, normalized.scale]))[0] || {};
    return Object.freeze({ workspaceUsedUnits: String(ws?.settled_units || '0'), workspaceHeldUnits: String(ws?.reserved_units || '0'), organizationUsedUnits: String(org.settled_units || '0'), organizationHeldUnits: String(org.reserved_units || '0') });
  }

  return Object.freeze({ getWorkspacePolicyForUpdate, setWorkspacePolicy, setOrganizationFallbackMode, reserveExposure, releaseExposure, settleReservedExposure, reverseSettledExposure, recordDebtJournal, getExposure });
}

module.exports = { createMysqlPostpaidRepository, mapPostpaidPolicy: mapPolicy };
