'use strict';

const { getPool } = require('../db/pool');
const { validateId } = require('./kernel/scope');
const { aggregateBalances } = require('./overviewReadModel');

/** Only live credits held by this workspace pool; never expose the organization pool. */
async function readWorkspaceBillingOverview(orgId,workspaceId,{pool=getPool(),now=new Date()}={}) {
  validateId(orgId,'orgId');
  validateId(workspaceId,'workspaceId');
  const connection=await pool.connect();
  let started=false;
  try {
    await connection.query('START TRANSACTION READ ONLY');
    started=true;
    const workspace=(await connection.query(
      'SELECT id,name,status FROM workspaces WHERE org_id=? AND id=?',[orgId,workspaceId])).rows[0];
    if (!workspace) {
      await connection.query('COMMIT');
      started=false;
      return null;
    }
    const account=(await connection.query(
      'SELECT status,hold_reason FROM organization_billing_accounts WHERE org_id=?',[orgId])).rows[0];
    const at=now.toISOString();
    const balances=account ? (await connection.query(`SELECT g.grant_kind,g.expires_at,
        p.asset,p.scale,p.balance_units,p.reserved_units
      FROM billing_credit_positions p
      JOIN billing_credit_accounts a ON a.org_id=p.org_id AND a.id=p.account_id
      JOIN billing_credit_grants g ON g.org_id=p.org_id AND g.id=p.grant_id
      WHERE p.org_id=? AND a.account_type='workspace' AND a.owner_id=?
        AND a.account_purpose='pool' AND a.status='active'
        AND g.grant_kind IN ('subscription','topup') AND g.status='active'
        AND g.effective_at<=? AND (g.expires_at IS NULL OR g.expires_at>?)
      ORDER BY g.grant_kind,g.expires_at,g.id`,[orgId,workspaceId,at,at])).rows : [];
    const result={orgId,workspaceId,workspaceName:workspace.name,
      uninitialized:!account,
      status:workspace.status !== 'Active' ? 'suspended'
        : account && (account.status !== 'active' || account.hold_reason) ? 'held' : 'active',
      balances:aggregateBalances(balances)};
    await connection.query('COMMIT');
    started=false;
    return result;
  } catch(error) {
    if(started) await connection.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally { connection.release(); }
}

function requireSelectedBillingWorkspace(req,res,next) {
  if (req.params.workspaceId !== req.workspaceId) {
    return res.status(403).json({error:'Select this workspace before viewing its billing.'});
  }
  return next();
}

module.exports={readWorkspaceBillingOverview,requireSelectedBillingWorkspace};
