'use strict';

const { assertTransactionContext } = require('../../../kernel/transactionContext');
const { validateId } = require('../../../kernel/scope');
const { validateAmount } = require('../../../kernel/amount');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');

function rowsOf(value) {
  const result = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value;
  return Array.isArray(result) ? result : result?.rows || [];
}
function affectedRows(value) {
  const result = Array.isArray(value) && value.length === 2 && !Array.isArray(value[0]) ? value[0] : value;
  return Number(result?.affectedRows ?? result?.rowCount ?? 0);
}
function parseJson(value, label) {
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch (cause) { throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, `${label} contains invalid JSON.`, { retryable: true, details: { cause: cause.message } }); }
}
function iso(value) {
  const result = value instanceof Date ? value : new Date(/Z$|[+-]\d\d:\d\d$/.test(String(value)) ? value : `${String(value).replace(' ', 'T')}Z`);
  if (!Number.isFinite(result.getTime())) throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Stored funding timestamp is invalid.', { retryable: true });
  return result.toISOString();
}
function assertOrg(tx, orgId) {
  assertTransactionContext(tx);
  validateId(orgId, 'orgId');
  if (tx.metadata?.orgId !== orgId) throw new TypeError('Reservation organization must match transaction organization.');
}
function requiredText(value, field, max = 191) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, `${field} must be a non-empty string of at most ${max} characters.`);
  return value;
}
function mapReservation(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id, orgId: row.org_id, workspaceId: row.workspace_id,
    usageOperationId: row.usage_operation_id, sourceRevision: row.source_revision,
    fundingPolicyVersion: row.funding_policy_version,
    fundingSnapshot: parseJson(row.funding_snapshot_json, 'Funding reservation snapshot'),
    status: row.status, validUntil: iso(row.valid_until), version: Number(row.version),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), closedAt: row.closed_at ? iso(row.closed_at) : null,
  });
}
function mapLine(row) {
  return Object.freeze({
    id: row.id, orgId: row.org_id, reservationId: row.reservation_id, lineNumber: Number(row.line_number),
    fundingSource: row.funding_source, positionId: row.credit_position_id, grantId: row.credit_grant_id,
    accountId: row.credit_account_id, periodId: row.period_id || null,
    amount: Object.freeze({ units: String(row.amount_units), asset: row.asset, scale: Number(row.scale) }),
    heldUnits: String(row.held_units), consumedUnits: String(row.consumed_units), releasedUnits: String(row.released_units),
    fundingSnapshot: parseJson(row.funding_snapshot_json, 'Reservation line funding snapshot'),
  });
}

function createMysqlReservationRepository({ idSource, clock } = {}) {
  if (typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function') throw new TypeError('Reservation repository requires an ID source and clock.');

  async function getWorkspaceForUpdate(tx, { orgId, workspaceId }) {
    assertOrg(tx, orgId);
    const row = rowsOf(await tx.query(
      `SELECT id,org_id,name,industry,status,settings FROM workspaces WHERE org_id=? AND id=? FOR UPDATE`,
      [orgId, validateId(workspaceId, 'workspaceId')],
    ))[0];
    if (!row) return null;
    return Object.freeze({ id: row.id, orgId: row.org_id, name: row.name, industry: row.industry,
      status: row.status, settings: parseJson(row.settings || '{}', 'Workspace settings') });
  }

  async function getBillingAccountForUpdate(tx, { orgId }) {
    assertOrg(tx, orgId);
    const row = rowsOf(await tx.query(
      `SELECT org_id,fallback_mode,enforcement_version,status,hold_reason FROM organization_billing_accounts WHERE org_id=? FOR UPDATE`, [orgId],
    ))[0];
    if (!row) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Organization billing account does not exist.');
    if (row.status !== 'active' || row.hold_reason) throw new BillingDomainError(DOMAIN_ERROR_CODES.CONFLICT, 'Organization billing account is held or inactive.', { details: { status: row.status, holdReason: row.hold_reason || null } });
    return Object.freeze({ orgId, fallbackMode: row.fallback_mode, enforcementVersion: Number(row.enforcement_version), status: row.status });
  }

  async function listWorkspacePositionsForUpdate(tx, { orgId, workspaceId }) {
    assertOrg(tx, orgId);
    const rows = rowsOf(await tx.query(
      `SELECT p.id AS position_id,p.org_id,p.grant_id,p.account_id,p.asset,p.scale,p.balance_units,p.reserved_units,p.version AS position_version,
              a.account_type,a.owner_id,a.workspace_id,a.account_purpose,a.status AS account_status,
              g.grant_kind,g.status AS grant_status,g.amount_units AS grant_amount_units,g.effective_at,g.expires_at,g.period_id
         FROM billing_credit_positions p
         INNER JOIN billing_credit_accounts a ON a.org_id=p.org_id AND a.id=p.account_id
         INNER JOIN billing_credit_grants g ON g.org_id=p.org_id AND g.id=p.grant_id
        WHERE p.org_id=? AND a.account_type='workspace' AND a.owner_id=? AND a.workspace_id=? AND a.account_purpose='pool'
          AND a.status='active' AND g.status='active' AND g.grant_kind IN ('subscription','topup')
        ORDER BY p.id FOR UPDATE`, [orgId, workspaceId],
    ));
    return rows.map((row) => Object.freeze({
      orgId: row.org_id, workspaceId: row.workspace_id, accountType: row.account_type, ownerId: row.owner_id,
      accountId: row.account_id, accountPurpose: row.account_purpose, accountStatus: row.account_status,
      positionId: row.position_id, grantId: row.grant_id, grantKind: row.grant_kind, grantStatus: row.grant_status,
      amount: Object.freeze({ asset: row.asset, scale: Number(row.scale), units: String(row.grant_amount_units) }),
      balanceUnits: String(row.balance_units), reservedUnits: String(row.reserved_units), version: Number(row.position_version),
      effectiveAt: iso(row.effective_at), expiresAt: row.expires_at == null ? null : iso(row.expires_at), periodId: row.period_id || null,
    }));
  }

  async function getByUsageKey(tx, { orgId, workspaceId, usageOperationId, sourceRevision = '0', forUpdate = false }) {
    assertOrg(tx, orgId);
    const row = rowsOf(await tx.query(
      `SELECT id,org_id,workspace_id,usage_operation_id,source_revision,funding_policy_version,funding_snapshot_json,status,valid_until,version,created_at,updated_at,closed_at
         FROM billing_reservations WHERE org_id=? AND workspace_id=? AND usage_operation_id=? AND source_revision=?${forUpdate ? ' FOR UPDATE' : ''}`,
      [orgId, workspaceId, usageOperationId, sourceRevision],
    ))[0];
    return mapReservation(row);
  }

  async function getForUpdate(tx, { orgId, reservationId }) {
    assertOrg(tx, orgId);
    return mapReservation(rowsOf(await tx.query(
      `SELECT id,org_id,workspace_id,usage_operation_id,source_revision,funding_policy_version,funding_snapshot_json,status,valid_until,version,created_at,updated_at,closed_at
         FROM billing_reservations WHERE org_id=? AND id=? FOR UPDATE`, [orgId, validateId(reservationId, 'reservationId')],
    ))[0]);
  }

  async function listLinesForUpdate(tx, { orgId, reservationId }) {
    assertOrg(tx, orgId);
    return rowsOf(await tx.query(
      `SELECT id,org_id,reservation_id,line_number,funding_source,credit_position_id,credit_grant_id,credit_account_id,period_id,
              amount_units,asset,scale,held_units,consumed_units,released_units,funding_snapshot_json
         FROM billing_reservation_lines WHERE org_id=? AND reservation_id=? ORDER BY line_number FOR UPDATE`, [orgId, reservationId],
    )).map(mapLine);
  }

  async function createReservation(tx, record) {
    assertOrg(tx, record.orgId);
    const id = requiredText(record.id || idSource.newId('billing-reservation'), 'reservationId');
    const now = record.now || clock.now();
    const snapshot = jsonSnapshot(record.fundingSnapshot);
    await tx.query(
      `INSERT INTO billing_reservations
        (id,org_id,workspace_id,usage_operation_id,source_revision,funding_policy_version,funding_snapshot_json,status,valid_until,version,created_at,updated_at,closed_at)
       VALUES (?,?,?,?,?,?,?,'reserved',?,1,?,?,NULL)`,
      [id, record.orgId, record.workspaceId, record.usageOperationId, record.sourceRevision || '0',
        String(record.fundingPolicyVersion), JSON.stringify(snapshot), record.validUntil, now, now],
    );
    await insertLines(tx, { orgId: record.orgId, reservationId: id, lines: record.lines, now, lineNumberStart: 1 });
    return getForUpdate(tx, { orgId: record.orgId, reservationId: id });
  }

  async function appendLines(tx, { orgId, reservationId, lines, now }) {
    assertOrg(tx, orgId);
    const existing = await listLinesForUpdate(tx, { orgId, reservationId });
    await insertLines(tx, { orgId, reservationId, lines, now: now || clock.now(), lineNumberStart: existing.length + 1 });
    return listLinesForUpdate(tx, { orgId, reservationId });
  }

  async function insertLines(tx, { orgId, reservationId, lines, now, lineNumberStart }) {
    if (!Array.isArray(lines) || !lines.length) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Reservation must contain at least one funding line.');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const amount = validateAmount(line.amount);
      if (BigInt(amount.units) <= 0n) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Reservation funding line amount must be positive.');
      if (line.fundingSource === 'postpaid') {
        if (line.positionId != null || line.grantId != null || line.accountId != null || !line.periodId) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Postpaid reservation lines require only a billing period source.');
      } else if (!line.positionId || !line.grantId || !line.accountId) {
        throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Prepaid reservation lines require credit position, grant, and account IDs.');
      }
      await tx.query(
        `INSERT INTO billing_reservation_lines
          (id,org_id,reservation_id,line_number,funding_source,credit_position_id,credit_grant_id,credit_account_id,period_id,
           amount_units,asset,scale,held_units,consumed_units,released_units,funding_snapshot_json,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,0,0,?,?,?)`,
        [idSource.newId('billing-reservation-line'), orgId, reservationId, lineNumberStart + index, line.fundingSource,
          line.positionId, line.grantId, line.accountId, line.periodId || null, amount.units, amount.asset, amount.scale,
          amount.units, JSON.stringify(jsonSnapshot(line.fundingSnapshot)), now, now],
      );
    }
  }

  async function updateReservation(tx, { orgId, reservationId, expectedVersion, status, validUntil, fundingSnapshot, closedAt = null, now = clock.now() }) {
    assertOrg(tx, orgId);
    const result = await tx.query(
      `UPDATE billing_reservations SET status=?,valid_until=?,funding_snapshot_json=?,version=version+1,updated_at=?,closed_at=?
        WHERE org_id=? AND id=? AND version=?`,
      [status, validUntil, JSON.stringify(jsonSnapshot(fundingSnapshot)), now, closedAt, orgId, reservationId, expectedVersion],
    );
    if (affectedRows(result) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Funding reservation changed concurrently.');
    return getForUpdate(tx, { orgId, reservationId });
  }

  async function markLineReleased(tx, { orgId, line, now }) {
    assertOrg(tx, orgId);
    const remaining = BigInt(line.heldUnits) - BigInt(line.consumedUnits) - BigInt(line.releasedUnits);
    if (remaining <= 0n) return false;
    const nextReleased = BigInt(line.releasedUnits) + remaining;
    const result = await tx.query(
      `UPDATE billing_reservation_lines SET released_units=?,updated_at=?
        WHERE org_id=? AND id=? AND held_units=? AND consumed_units=? AND released_units=?`,
      [nextReleased.toString(), now, orgId, line.id, line.heldUnits, line.consumedUnits, line.releasedUnits],
    );
    if (affectedRows(result) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Reservation line changed concurrently.');
    return true;
  }

  async function markLineConsumed(tx, { orgId, line, amountUnits, now }) {
    assertOrg(tx, orgId);
    const units = BigInt(amountUnits);
    const remaining = BigInt(line.heldUnits) - BigInt(line.consumedUnits) - BigInt(line.releasedUnits);
    if (units <= 0n || units > remaining) throw new BillingDomainError(DOMAIN_ERROR_CODES.RESERVATION_STATE_CONFLICT, 'Consumption must be positive and no greater than the reservation line hold.');
    const result = await tx.query(`UPDATE billing_reservation_lines SET consumed_units=consumed_units+?,updated_at=?
      WHERE org_id=? AND id=? AND held_units=? AND consumed_units=? AND released_units=?`,
    [units.toString(), now, orgId, line.id, line.heldUnits, line.consumedUnits, line.releasedUnits]);
    if (affectedRows(result) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Reservation line changed while usage was settling.');
    return true;
  }

  async function adjustLineConsumed(tx, { orgId, line, deltaUnits, now }) {
    assertOrg(tx, orgId);
    const delta = BigInt(deltaUnits);
    const next = BigInt(line.consumedUnits) + delta;
    if (delta === 0n || next < 0n || next > BigInt(line.heldUnits) - BigInt(line.releasedUnits)) throw new BillingDomainError(DOMAIN_ERROR_CODES.RESERVATION_STATE_CONFLICT, 'Reservation line correction would exceed its consumed range.');
    const result = await tx.query(`UPDATE billing_reservation_lines SET consumed_units=?,updated_at=?
      WHERE org_id=? AND id=? AND held_units=? AND consumed_units=? AND released_units=?`,
    [next.toString(), now, orgId, line.id, line.heldUnits, line.consumedUnits, line.releasedUnits]);
    if (affectedRows(result) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Reservation line changed while usage correction was settling.');
    return true;
  }

  async function getWorkspaceCycleExposure(tx, { orgId, workspaceId, periodStart, periodEnd, asset, scale, excludeReservationId }) {
    assertOrg(tx, orgId);
    const amount = validateAmount({ asset, units: '0', scale });
    if (!periodStart || !periodEnd || Date.parse(periodEnd) <= Date.parse(periodStart)) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Workspace cycle exposure requires a valid period window.');
    const excluded = excludeReservationId ? 'AND r.id<>?' : '';
    const row = rowsOf(await tx.query(
      `SELECT
         COALESCE((SELECT -SUM(jl.amount_units)
           FROM billing_journal_lines jl
           INNER JOIN billing_journals j ON j.org_id=jl.org_id AND j.id=jl.journal_id
           INNER JOIN billing_credit_accounts a ON a.org_id=jl.org_id AND a.id=jl.account_id
          WHERE jl.org_id=? AND a.account_type='workspace' AND a.workspace_id=? AND jl.asset=? AND jl.scale=?
            AND jl.entry_type='credit_consumption' AND j.created_at>=? AND j.created_at<?),0)
         + COALESCE((SELECT SUM(t.settled_units)
            FROM billing_postpaid_period_totals t
            INNER JOIN billing_periods p ON p.org_id=t.org_id AND p.id=t.period_id
           WHERE t.org_id=? AND t.scope_type='workspace' AND t.scope_owner_id=? AND t.asset=? AND t.scale=?
             AND p.starts_at>=? AND p.ends_at<=?),0) AS used_units,
         COALESCE((SELECT SUM(l.held_units-l.consumed_units-l.released_units)
           FROM billing_reservation_lines l
           INNER JOIN billing_reservations r ON r.org_id=l.org_id AND r.id=l.reservation_id
         WHERE r.org_id=? AND r.workspace_id=? AND l.asset=? AND l.scale=?
            AND r.status IN ('reserved','partially_consumed')
            AND r.created_at>=? AND r.created_at<? ${excluded}),0) AS held_units`,
      [orgId, workspaceId, asset, scale, periodStart, periodEnd,
        orgId, workspaceId, asset, scale, periodStart, periodEnd,
        orgId, workspaceId, asset, scale, periodStart, periodEnd,
        ...(excludeReservationId ? [excludeReservationId] : [])],
    ))[0] || {};
    return Object.freeze({ usedUnits: String(row.used_units || '0'), heldUnits: String(row.held_units || '0'), asset: amount.asset, scale: amount.scale });
  }

  return Object.freeze({
    getWorkspaceForUpdate, getBillingAccountForUpdate, listWorkspacePositionsForUpdate,
    getByUsageKey, getForUpdate, listLinesForUpdate, createReservation, appendLines,
    updateReservation, markLineReleased, markLineConsumed, adjustLineConsumed, getWorkspaceCycleExposure,
  });
}

function jsonSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Funding snapshot must be a JSON object.');
  let encoded;
  try { encoded = JSON.stringify(value); } catch (cause) { throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Funding snapshot must be JSON-safe.', { details: { cause: cause.message } }); }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 256 * 1024) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Funding snapshot must be JSON-safe and at most 256 KiB.');
  return JSON.parse(encoded);
}

module.exports = { createMysqlReservationRepository, mapReservation, mapReservationLine: mapLine, reservationJsonSnapshot: jsonSnapshot };
