'use strict';

const { getPool } = require('../db/pool');
const { validateId } = require('./kernel/scope');
const { dateIso } = require('./overviewReadModel');

function amount(asset, units, scale) {
  return { asset, units: String(units), scale: Number(scale) };
}
function availableUnits(row) {
  const balance = BigInt(row.balance_units);
  const reserved = BigInt(row.reserved_units);
  if (balance < 0n || reserved < 0n || reserved > balance) throw new TypeError('Inconsistent credit ledger position.');
  return balance - reserved;
}
function groupBalances(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.account_type, row.owner_id, row.grant_kind, row.asset, row.scale].join('|');
    const prior = groups.get(key) || {
      ownerType: row.account_type, ownerId: row.owner_id, kind: row.grant_kind,
      asset: row.asset, scale: Number(row.scale), available: 0n, reserved: 0n,
    };
    prior.available += availableUnits(row);
    prior.reserved += BigInt(row.reserved_units);
    groups.set(key, prior);
  }
  return [...groups.values()].map(item => ({
    ownerType: item.ownerType, ownerId: item.ownerId, kind: item.kind,
    available: amount(item.asset, item.available.toString(), item.scale),
    held: amount(item.asset, item.reserved.toString(), item.scale),
  }));
}

/**
 * Credit allocation is a distinct ledger from the legacy INR recharge wallet.
 * All the reads run on one MySQL read-only transaction and never move credits.
 */
async function readManualAllocationOverview(orgId, { pool = getPool(), now = new Date() } = {}) {
  validateId(orgId, 'orgId');
  const at = now.toISOString();
  const connection = await pool.connect();
  let started = false;
  try {
    await connection.query('START TRANSACTION READ ONLY');
    started = true;
    const account = (await connection.query(
      'SELECT status,hold_reason FROM organization_billing_accounts WHERE org_id=?',
      [orgId],
    )).rows[0];
    if (!account) {
      await connection.query('COMMIT');
      started = false;
      return { uninitialized: true, workspaces: [], balances: [], grants: [], history: [] };
    }
    const workspaces = (await connection.query(
      'SELECT id,name,status FROM workspaces WHERE org_id=? ORDER BY is_default DESC,name,id', [orgId],
    )).rows;
    const rows = (await connection.query(`SELECT p.grant_id,p.balance_units,p.reserved_units,p.version,
        p.asset,p.scale,a.account_type,a.owner_id,g.grant_kind,g.expires_at,g.effective_at
      FROM billing_credit_positions p
      JOIN billing_credit_accounts a ON a.org_id=p.org_id AND a.id=p.account_id
      JOIN billing_credit_grants g ON g.org_id=p.org_id AND g.id=p.grant_id
      WHERE p.org_id=? AND a.account_purpose='pool' AND a.status='active'
        AND g.status='active' AND g.effective_at<=?
        AND (g.expires_at IS NULL OR g.expires_at>?)
      ORDER BY g.expires_at ASC,g.id,a.account_type,a.owner_id`, [orgId, at, at])).rows;
    const historyRows = (await connection.query(`SELECT j.id,j.created_at,j.actor_id,
        outbound.grant_id, inbound.amount_units,inbound.asset,inbound.scale,
        target.owner_id AS workspace_id,w.name AS workspace_name
      FROM billing_journals j
      JOIN billing_journal_lines outbound ON outbound.org_id=j.org_id
        AND outbound.journal_id=j.id AND outbound.entry_type='transfer_out'
      JOIN billing_credit_accounts source ON source.org_id=j.org_id
        AND source.id=outbound.account_id AND source.account_type='organization'
        AND source.account_purpose='pool'
      JOIN billing_journal_lines inbound ON inbound.org_id=j.org_id
        AND inbound.journal_id=j.id AND inbound.grant_id=outbound.grant_id
        AND inbound.entry_type='transfer_in' AND inbound.amount_units=-outbound.amount_units
      JOIN billing_credit_accounts target ON target.org_id=j.org_id
        AND target.id=inbound.account_id AND target.account_type='workspace'
        AND target.account_purpose='pool'
      LEFT JOIN workspaces w ON w.org_id=target.org_id AND w.id=target.owner_id
      WHERE j.org_id=? AND j.operation_type='credit_transfer'
      ORDER BY j.created_at DESC,j.id DESC LIMIT 50`, [orgId])).rows;
    const result = {
      uninitialized: false,
      writable: String(account.status).toLowerCase() === 'active' && !account.hold_reason,
      workspaces: workspaces.map(w => ({ id: w.id, name: w.name, status: w.status })),
      balances: groupBalances(rows),
      grants: rows.filter(row => row.account_type === 'organization' && row.owner_id === orgId
        && availableUnits(row) > 0n).map(row => ({
        id: row.grant_id, kind: row.grant_kind, expiresAt: dateIso(row.expires_at),
        available: amount(row.asset, availableUnits(row).toString(), row.scale),
        held: amount(row.asset, row.reserved_units, row.scale),
        positionVersion: Number(row.version),
      })),
      history: historyRows.map(row => ({
        id: row.id, grantId: row.grant_id, workspaceId: row.workspace_id,
        workspaceName: row.workspace_name || row.workspace_id,
        amount: amount(row.asset, row.amount_units, row.scale),
        createdAt: dateIso(row.created_at), actorId: row.actor_id || null,
      })),
    };
    await connection.query('COMMIT');
    started = false;
    return result;
  } catch (error) {
    if (started) await connection.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { connection.release(); }
}

/** Pure exact-unit preview. A confirm still rechecks the ledger under lock. */
function previewManualAllocation(snapshot, { grantId, workspaceId, amountUnits, expectedPositionVersion }) {
  validateId(grantId, 'grantId');
  validateId(workspaceId, 'workspaceId');
  if (typeof amountUnits !== 'string' || !/^[1-9][0-9]*$/.test(amountUnits))
    throw new TypeError('amountUnits must be a positive integer string.');
  if (!Number.isSafeInteger(expectedPositionVersion) || expectedPositionVersion < 0)
    throw new TypeError('expectedPositionVersion must be a non-negative version.');
  if (snapshot.uninitialized || !snapshot.writable)
    throw Object.assign(new Error('Organization billing ledger is not ready for allocation.'), { statusCode: 409 });
  const grant = snapshot.grants.find(row => row.id === grantId);
  const workspace = snapshot.workspaces.find(row => row.id === workspaceId);
  if (!workspace) throw Object.assign(new Error('Workspace not found in this organization.'), { statusCode: 404 });
  if (String(workspace.status).toLowerCase() !== 'active')
    throw Object.assign(new Error('Credits cannot be allocated to an inactive workspace.'), { statusCode: 409 });
  if (!grant) throw Object.assign(new Error('Available credit grant was not found.'), { statusCode: 404 });
  if (grant.positionVersion !== expectedPositionVersion)
    throw Object.assign(new Error('Credit balance changed. Refresh before confirming.'), { statusCode: 409 });
  const units = BigInt(amountUnits);
  const available = BigInt(grant.available.units);
  if (units > available)
    throw Object.assign(new Error('Allocation exceeds unreserved credits in this grant.'), { statusCode: 409 });
  return {
    grantId, workspaceId, workspaceName: workspace.name, kind: grant.kind,
    amount: amount(grant.available.asset, amountUnits, grant.available.scale),
    remaining: amount(grant.available.asset, (available - units).toString(), grant.available.scale),
    expiresAt: grant.expiresAt, expectedPositionVersion,
  };
}

module.exports = { readManualAllocationOverview, previewManualAllocation, groupBalances, availableUnits };
