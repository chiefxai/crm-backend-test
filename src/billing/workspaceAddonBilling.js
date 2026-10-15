'use strict';

const crypto = require('node:crypto');
const { createMysqlUnitOfWork } = require('./adapters/mysql/unitOfWork');
const operationStore = require('./adapters/mysql/commandOperationRepository');
const { fingerprint } = require('./modules/payments/decisions');
const { addCalendarInterval } = require('./modules/subscriptions/periodMath');
const { rowsOf } = require('./modules/payments/repositories/mysqlPaymentSubmissionRepository');
const policyModule = require('../workspaces/organizationPolicy');
const { assertTransactionContext } = require('./kernel/transactionContext');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('./contracts/errors');
const { createMysqlCreditRepository } = require('./modules/credits/repositories/mysqlCreditRepository');

const DAY = 86400000;
const GRACE_DAYS = 7;
const LEAD_DAYS = 7;
const iso = value => value == null ? null : new Date(value).toISOString();
const monthBoundary = (anchor, index) => addCalendarInterval(anchor, { unit: 'month', count: index }, { timeZone: 'UTC' });
const shiftDays = (value, days) => new Date(Date.parse(value) + days * DAY).toISOString();
const fail = (message, statusCode = 409) => { throw policyModule.invalid(message, statusCode); };
function purchasesEnabled(env = process.env) {
  return env.BILLING_PAYMENT_SUBMISSION_ENABLED === 'true' && env.BILLING_PAYMENT_DECISION_ENABLED === 'true';
}
function topupRedemptionEnabled(env = process.env) {
  return env.BILLING_WORKSPACE_TOPUP_REDEMPTION_ENABLED === 'true';
}
function paymentAmount(units) { return { asset: 'INR', units: String(units), scale: 2 }; }
function validateWorkspaceInput(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const industry = typeof input?.industry === 'string' ? input.industry.trim() : '';
  const branchName = typeof input?.branchName === 'string' ? input.branchName.trim() || null : null;
  if (!name || name.length > 120 || (branchName && branchName.length > 160)) fail('Enter a valid workspace and branch name.', 400);
  if (!require('../seed/industryPacks').listIndustries().some(item => item.key === industry)) fail('Select a supported workspace industry.',400);
  return { name, industry, branchName };
}

function createWorkspaceAddonBilling({
  pool = require('../db/pool').getPool(),
  clock = { now: () => new Date().toISOString() },
  idSource = { newId: prefix => `${prefix}-${crypto.randomUUID()}` },
  provisionWorkspace = (...args) => require('../db/repositories/workspaceRepository').createWorkspaceInTransaction(...args),
  creditRepository = null,
} = {}) {
  const uow = createMysqlUnitOfWork({ pool, clock, idSource, operationStore });
  const notifications = require('./modules/notifications/repositories/mysqlNotificationRepository').createMysqlNotificationRepository({idSource,clock});
  const credits = creditRepository || createMysqlCreditRepository({idSource,clock});
  const query = async (tx, sql, params) => rowsOf(await tx.query(sql, params));

  async function lockOrganization(tx, orgId) {
    const org = (await query(tx, 'SELECT id,status,industry,settings FROM organizations WHERE id=? FOR UPDATE', [orgId]))[0];
    if (!org || String(org.status || 'Active').toLowerCase() === 'suspended') fail('An active organization is required.',404);
    return org;
  }

  async function issueInvoice(tx, addon, { index, startsAt = null, endsAt = null, now }) {
    const prior = (await query(tx, 'SELECT invoice_id FROM billing_workspace_addon_cycles WHERE org_id=? AND addon_id=? AND cycle_index=?', [addon.org_id,addon.id,index]))[0];
    if (prior) return prior.invoice_id;
    const invoiceId = idSource.newId('billing-workspace-invoice');
    const cycleId = idSource.newId('billing-workspace-cycle');
    const dueAt = startsAt || shiftDays(now,1);
    const terms = { schemaVersion:1, purpose:'workspace_addon', addonId:addon.id,
      workspaceName:addon.name, monthlyAmount:paymentAmount(addon.monthly_units),
      interval:{unit:'month',count:1}, timezone:'UTC', cycleIndex:index,
      startsAt,endsAt, startsOnApproval: !startsAt, lateRenewalRestartsAfterGrace:true,
      graceDays:GRACE_DAYS, usageCreditsEligible:false, separatelyInvoiced:true,
      planSnapshot:policyModule.json(addon.terms_snapshot_json) };
    await tx.query(`INSERT INTO billing_invoices
      (id,org_id,invoice_number,status,asset,scale,subtotal_units,tax_units,total_units,paid_units,issued_at,due_at,terms_snapshot_json,version,created_at,updated_at)
      VALUES (?,?,?,'open','INR',2,?,0,?,0,?,?,?,1,?,?)`,
    [invoiceId,addon.org_id,`WS-${crypto.randomUUID()}`,String(addon.monthly_units),String(addon.monthly_units),now,dueAt,JSON.stringify(terms),now,now]);
    await tx.query(`INSERT INTO billing_invoice_lines
      (id,org_id,invoice_id,line_number,line_key,workspace_id,source_type,source_id,source_revision,description_snapshot,workspace_snapshot_json,line_snapshot_json,amount_units,asset,scale,created_at)
      VALUES (?,?,?,1,?,?,'workspace_addon',?,?,?,?,?,?,'INR',2,?)`,
    [idSource.newId('billing-invoice-line'),addon.org_id,invoiceId,`${addon.id}:${index}`,addon.workspace_id || null,
      addon.id,String(index),`Workspace add-on: ${addon.name} (one month)`,JSON.stringify({workspaceId:addon.workspace_id || null,name:addon.name}),JSON.stringify(terms),String(addon.monthly_units),now]);
    await tx.query(`INSERT INTO billing_workspace_addon_cycles (id,org_id,addon_id,invoice_id,cycle_index,starts_at,ends_at,created_at)
      VALUES (?,?,?,?,?,?,?,?)`,[cycleId,addon.org_id,addon.id,invoiceId,index,startsAt,endsAt,now]);
    if (addon.workspace_id) {
      const title = 'Workspace add-on renewal due';
      const message = `Renew ${addon.name} for ₹${(Number(addon.monthly_units)/100).toFixed(2)} per month. Payment is due on ${dueAt.slice(0,10)}; unpaid access ends after the seven-day grace period.`;
      await notifications.createNotification(tx,{orgId:addon.org_id,now,notification:{
        notificationKey:`workspace-addon-renewal:${invoiceId}`,eventKey:'workspace_addon.renewal_due',scopeType:'organization',scopeOwnerId:addon.org_id,
        title,message,actionPath:'/settings/billing',occurredAt:now,payload:{title,message,actionUrl:require('../email/appUrl').getPublicAppUrl()+'/settings/billing',addonId:addon.id,invoiceId},
      }});
    }
    return invoiceId;
  }

  async function preparePurchaseInTransaction(tx, {orgId, memberId, input, workspace}) {
        const org = await lockOrganization(tx,orgId);
        const workspaces = await query(tx,'SELECT id,industry FROM workspaces WHERE org_id=? ORDER BY id',[orgId]);
        const policy = policyModule.effectivePolicy(org,workspaces);
        if (workspace.industry !== policy.primaryIndustry) fail('Add-on workspaces must use the organization primary industry.',403);
        const seatRow = (await query(tx,"SELECT COUNT(*) AS count FROM org_members WHERE org_id=? AND COALESCE(NULLIF(status,''),'Active')='Active'",[orgId]))[0];
        const offered = policyModule.branchQuote(policy,workspaces,Number(seatRow?.count || 0));
        if (!offered?.paymentRequired) fail('This workspace does not require an add-on purchase. Refresh the workspace form.');
        if (input.pricingAcceptanceToken !== offered.token) fail('Workspace pricing changed. Refresh and confirm the current price.');
        const pending = await query(tx,"SELECT id,name FROM billing_workspace_addons WHERE org_id=? AND status='pending' FOR UPDATE",[orgId]);
        const cap = Math.max(2,Math.min(Number(process.env.MAX_WORKSPACES_PER_ORG) || 100,1000));
        if (workspaces.length + pending.length >= Math.min(policy.pricing.maxWorkspaces ?? cap,cap)) fail('All remaining workspace slots are in use or reserved by pending purchases.');
        if (pending.some(item => item.name.toLowerCase() === workspace.name.toLowerCase())) fail('A purchase for this workspace name already exists. Use its existing invoice.');
        if ((await query(tx,'SELECT id FROM workspaces WHERE org_id=? AND LOWER(name)=LOWER(?) LIMIT 1',[orgId,workspace.name]))[0]) fail('A workspace with this name already exists.');
        if (!(await query(tx,"SELECT id FROM org_members WHERE org_id=? AND id=? AND COALESCE(NULLIF(status,''),'Active')='Active' FOR UPDATE",[orgId,memberId]))[0]) fail('An active organization member is required.',403);
        const now = clock.now();
        const addon = {id:idSource.newId('billing-workspace-addon'),org_id:orgId,member_id:memberId,
          ...workspace,monthly_units:String(Math.round(policy.pricing.extraWorkspaceMonthlyInr * 100)),terms_snapshot_json:JSON.stringify(policy)};
        await tx.query(`INSERT INTO billing_workspace_addons
          (id,org_id,member_id,name,industry,branch_name,status,monthly_units,terms_snapshot_json,next_action_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'pending',?,?,?,?,?)`,
        [addon.id,orgId,memberId,workspace.name,workspace.industry,workspace.branchName,addon.monthly_units,addon.terms_snapshot_json,shiftDays(now,1),now,now]);
        const invoiceId = await issueInvoice(tx,addon,{index:0,now});
        return {id:addon.id,name:workspace.name,status:'pending',invoiceId,paymentAmount:paymentAmount(addon.monthly_units),monthlyAmount:paymentAmount(addon.monthly_units)};
  }

  async function createPurchase({ orgId, memberId, input, context }) {
    const workspace = validateWorkspaceInput(input);
    return uow.runFinancial({orgId,operationId:context.operationId,
      requestFingerprint:fingerprint({orgId,memberId,workspace,actorId:context.actor.id,
        pricingAcceptanceToken:input.pricingAcceptanceToken || null,paymentSource:'approved_receipt'}),
      callback:tx=>preparePurchaseInTransaction(tx,{orgId,memberId,input,workspace})});
  }

  const topupBalanceQuery = `SELECT p.grant_id,p.account_id,p.balance_units,p.reserved_units
    FROM billing_credit_positions p
    JOIN billing_credit_grants g ON g.org_id=p.org_id AND g.id=p.grant_id
    JOIN billing_credit_accounts a ON a.org_id=p.org_id AND a.id=p.account_id
    WHERE p.org_id=? AND a.account_type='organization' AND a.owner_id=?
      AND a.account_purpose='pool' AND a.status='active'
      AND g.grant_kind='topup' AND g.status='active' AND g.expires_at IS NULL
      AND g.effective_at<=? AND p.asset='INR' AND p.scale=2
      AND p.balance_units>p.reserved_units ORDER BY g.effective_at,p.grant_id`;

  async function availableTopupBalance(orgId) {
    const rows = rowsOf(await pool.query(topupBalanceQuery,[orgId,orgId,clock.now()]));
    return paymentAmount(rows.reduce((sum,row)=>sum+BigInt(row.balance_units)-BigInt(row.reserved_units),0n));
  }

  // Redeem ONLY already approved, unallocated top-up grants. A workspace-level
  // credit allocation and a subscription grant cannot fund a subscription fee.
  // The billing account lock and ledger journals prevent concurrent double spend.
  async function redeemOrganizationTopup(tx,{orgId,invoiceId,requiredUnits,context,now}) {
    const positions=await query(tx,topupBalanceQuery+' FOR UPDATE',[orgId,orgId,now]);
    let remaining=BigInt(requiredUnits);
    const clearing=await credits.ensureAccount(tx,{
      orgId,accountType:'organization',ownerId:orgId,asset:'INR',scale:2,
      accountPurpose:'workspace_fee_clearing',now});
    const redemptions=[];
    for (const position of positions) {
      if (remaining<=0n) break;
      const available=BigInt(position.balance_units)-BigInt(position.reserved_units);
      if (available<=0n) continue;
      const units=available<remaining?available:remaining;
      redemptions.push({grantId:position.grant_id,accountId:position.account_id,units});
      remaining-=units;
    }
    if (remaining>0n) fail('Not enough unallocated top-up credits. Add more credits or submit the workspace invoice for approval.',402);
    const entries=[];
    const positionDeltas=[];
    for (const item of redemptions) {
      entries.push({accountId:item.accountId,grantId:item.grantId,
        amountUnits:(-item.units).toString(),asset:'INR',scale:2,entryType:'workspace_fee_redemption'});
      entries.push({accountId:clearing.id,grantId:item.grantId,
        amountUnits:item.units.toString(),asset:'INR',scale:2,entryType:'workspace_fee_clearing'});
      positionDeltas.push({accountId:item.accountId,grantId:item.grantId,balanceDeltaUnits:(-item.units).toString(),
        reservedDeltaUnits:'0',asset:'INR',scale:2});
    }
    const journal=await credits.applyJournal(tx,{
      orgId,operationId:`${context.operationId}:topup-redemption`,
      operationType:'workspace_fee_redemption',sourceType:'workspace_addon_invoice',
      sourceId:invoiceId,actorType:'user',actorId:context.actor.id,
      reason:'Redeem paid top-up credits for one workspace add-on month',
      entries,positionDeltas,now});
    return {journalId:journal.journalId,charged:paymentAmount(requiredUnits)};
  }

  async function purchaseWithTopup({orgId,memberId,input,context}) {
    if(!topupRedemptionEnabled()) fail('Workspace purchases with top-up credits are not enabled.',503);
    const workspace=validateWorkspaceInput(input);
    return uow.runFinancial({orgId,operationId:context.operationId,
      requestFingerprint:fingerprint({orgId,memberId,workspace,actorId:context.actor.id,
        pricingAcceptanceToken:input.pricingAcceptanceToken || null,paymentSource:'topup_credits'}),
      callback:async tx=>{
        const prepared=await preparePurchaseInTransaction(tx,{orgId,memberId,input,workspace});
        const now=clock.now();
        const redemption=await redeemOrganizationTopup(tx,{orgId,invoiceId:prepared.invoiceId,
          requiredUnits:prepared.paymentAmount.units,context,now});
        const settled=await applyInvoicePayment(tx,{orgId,invoiceId:prepared.invoiceId,
          paymentRequestId:null,amount:prepared.paymentAmount,now,
          topupRedemptionJournalId:redemption.journalId});
        return { ...prepared,status:'active',paymentSource:'topup_credits',
          chargedTopupCredits:redemption.charged,
          workspaceId:settled.workspaceId,periodEndsAt:settled.periodEndsAt};
      }});
  }

  // Called inside the payment decision transaction. This only settles invoices
  // linked to a persisted workspace purchase; ordinary usage invoices return null.
  async function applyInvoicePayment(tx, {orgId,invoiceId,paymentRequestId,amount,now,topupRedemptionJournalId=null}) {
    assertTransactionContext(tx);
    if (!paymentRequestId && !topupRedemptionJournalId) fail('An approved payment or verified credit redemption is required.');
    if (paymentRequestId && topupRedemptionJournalId) fail('An invoice cannot use two payment methods.');
    if (tx.metadata?.orgId !== orgId) throw new TypeError('Workspace purchase organization must match the transaction.');
    const cycle = (await query(tx,'SELECT * FROM billing_workspace_addon_cycles WHERE org_id=? AND invoice_id=? FOR UPDATE',[orgId,invoiceId]))[0];
    if (!cycle) return null;
    await lockOrganization(tx,orgId);
    const addon = (await query(tx,'SELECT * FROM billing_workspace_addons WHERE org_id=? AND id=? FOR UPDATE',[orgId,cycle.addon_id]))[0];
    const invoice = (await query(tx,'SELECT * FROM billing_invoices WHERE org_id=? AND id=? FOR UPDATE',[orgId,invoiceId]))[0];
    if (!addon || addon.status === 'cancelled' || !invoice || cycle.paid_at || !['open','overdue'].includes(invoice.status)) fail('This workspace invoice is no longer payable.');
    if (amount.asset !== 'INR' || amount.scale !== 2 || BigInt(amount.units) !== BigInt(addon.monthly_units)
      || BigInt(invoice.total_units) !== BigInt(amount.units) || BigInt(invoice.paid_units) !== 0n) {
      throw new BillingDomainError(DOMAIN_ERROR_CODES.PAYMENT_AMOUNT_MISMATCH,'Workspace add-on invoices require payment of the full quoted amount.');
    }
    const paymentId = idSource.newId('billing-invoice-payment');
    await tx.query(`INSERT INTO billing_invoice_payments
      (id,org_id,invoice_id,payment_request_id,idempotency_key,amount_units,asset,scale,status,applied_at,created_at)
      VALUES (?,?,?,?,?,?,'INR',2,'applied',?,?)`,[paymentId,orgId,invoiceId,paymentRequestId,`workspace-addon:${paymentRequestId || 'credits:'+invoiceId}`,amount.units,now,now]);
    await tx.query("UPDATE billing_invoices SET status='paid',paid_units=total_units,paid_at=?,updated_at=?,version=version+1 WHERE org_id=? AND id=?",[now,now,orgId,invoiceId]);
    let workspaceId = addon.workspace_id;
    if (!workspaceId) {
      const workspace = await provisionWorkspace(tx,orgId,{name:addon.name,industry:addon.industry,branchName:addon.branch_name},addon.member_id,{billingAddonId:addon.id});
      workspaceId = workspace.id;
      await tx.query('UPDATE billing_invoice_lines SET workspace_id=? WHERE org_id=? AND invoice_id=?',[workspaceId,orgId,invoiceId]);
    }
    // Early renewal extends the existing anchor. Paying after the grace period
    // starts a fresh month; suspended months never accumulate charges.
    const restart = !addon.anchor_at || (addon.grace_ends_at && Date.parse(now) >= Date.parse(iso(addon.grace_ends_at)));
    const anchor = restart ? now : iso(addon.anchor_at);
    const startsAt = restart ? now : iso(cycle.starts_at) || now;
    const endsAt = restart ? monthBoundary(now,1) : iso(cycle.ends_at) || monthBoundary(anchor,1);
    await tx.query('UPDATE billing_workspace_addon_cycles SET starts_at=?,ends_at=?,paid_at=? WHERE org_id=? AND id=?',[startsAt,endsAt,now,orgId,cycle.id]);
    await tx.query(`UPDATE billing_workspace_addons SET workspace_id=?,status='active',anchor_at=?,period_ends_at=?,grace_ends_at=?,next_action_at=?,updated_at=? WHERE org_id=? AND id=?`,
    [workspaceId,anchor,endsAt,shiftDays(endsAt,GRACE_DAYS),shiftDays(endsAt,-LEAD_DAYS),now,orgId,addon.id]);
    // Only undo a suspension that this billing module applied.
    await tx.query(`UPDATE workspaces SET status='Active',settings=JSON_SET(COALESCE(settings,JSON_OBJECT()),'$.billingSuspended',false)
      WHERE org_id=? AND id=? AND status='Suspended' AND JSON_EXTRACT(settings,'$.billingSuspended')=true`,[orgId,workspaceId]);
    return {invoice:{id:invoiceId,status:'paid'},paymentId,workspaceId,addonId:addon.id,periodEndsAt:endsAt};
  }

  async function list(orgId) {
    const rows = rowsOf(await pool.query(`SELECT a.id,a.name,a.status,a.workspace_id,a.monthly_units,a.auto_renew,a.period_ends_at,a.grace_ends_at,
      c.invoice_id,c.starts_at,c.ends_at,i.status AS invoice_status,i.total_units,i.paid_units,i.due_at,
      (SELECT p.id FROM billing_payment_requests p WHERE p.org_id=a.org_id AND p.invoice_id=c.invoice_id AND p.status IN ('pending_verification','needs_clarification','clarification_requested') ORDER BY p.created_at DESC LIMIT 1) AS payment_request_id,
      (SELECT p.status FROM billing_payment_requests p WHERE p.org_id=a.org_id AND p.invoice_id=c.invoice_id ORDER BY p.created_at DESC LIMIT 1) AS payment_status,
      (SELECT CASE WHEN ip.payment_request_id IS NULL AND ip.idempotency_key LIKE 'workspace-addon:credits:%'
          THEN 'topup_credits' ELSE 'approved_payment' END
        FROM billing_invoice_payments ip
        WHERE ip.org_id=c.org_id AND ip.invoice_id=c.invoice_id AND ip.status='applied'
        ORDER BY ip.created_at DESC LIMIT 1) AS payment_source
      FROM billing_workspace_addons a
      LEFT JOIN billing_workspace_addon_cycles c ON c.org_id=a.org_id AND c.addon_id=a.id
        AND c.cycle_index=(SELECT MAX(c2.cycle_index) FROM billing_workspace_addon_cycles c2 WHERE c2.org_id=a.org_id AND c2.addon_id=a.id)
      LEFT JOIN billing_invoices i ON i.org_id=c.org_id AND i.id=c.invoice_id
      WHERE a.org_id=? AND a.status<>'cancelled' ORDER BY a.created_at DESC,a.id LIMIT 1000`,[orgId]));
    return rows.map(row => ({id:row.id,name:row.name,
      status:row.workspace_id && Date.parse(clock.now()) >= Date.parse(iso(row.auto_renew ? row.grace_ends_at : row.period_ends_at)) ? 'suspended' : row.status,
      workspaceId:row.workspace_id,
      monthlyAmount:paymentAmount(row.monthly_units),autoRenew:Boolean(row.auto_renew),periodEndsAt:iso(row.period_ends_at),graceEndsAt:iso(row.grace_ends_at),
      invoice:row.invoice_id ? {id:row.invoice_id,status:row.invoice_status,paymentAmount:paymentAmount(BigInt(row.total_units)-BigInt(row.paid_units)),dueAt:iso(row.due_at),paymentRequestId:row.payment_request_id,paymentStatus:row.payment_status,paymentSource:row.payment_source || null} : null}));
  }

  async function changeRenewal({orgId,addonId,autoRenew,context}) {
    if (typeof autoRenew !== 'boolean') fail('Auto-renew must be true or false.',400);
    return uow.runFinancial({orgId,operationId:context.operationId,requestFingerprint:fingerprint({orgId,addonId,autoRenew,actor:context.actor.id}),callback:async tx => {
      const addon = (await query(tx,'SELECT * FROM billing_workspace_addons WHERE org_id=? AND id=? FOR UPDATE',[orgId,addonId]))[0];
      if (!addon || !['active','suspended'].includes(addon.status)) fail('An existing workspace add-on is required.',404);
      const unpaid = await query(tx,`SELECT i.id FROM billing_workspace_addon_cycles c JOIN billing_invoices i ON i.org_id=c.org_id AND i.id=c.invoice_id
        WHERE c.org_id=? AND c.addon_id=? AND i.status IN ('open','overdue')`,[orgId,addonId]);
      if (!autoRenew) {
        for (const invoice of unpaid) {
          if ((await query(tx,"SELECT id FROM billing_payment_requests WHERE org_id=? AND invoice_id=? AND status IN ('pending_verification','needs_clarification','clarification_requested') LIMIT 1",[orgId,invoice.id]))[0]) fail('Resolve the submitted renewal payment before cancelling renewal.');
          await tx.query("UPDATE billing_invoices SET status='void',voided_at=?,updated_at=?,version=version+1 WHERE org_id=? AND id=?",[clock.now(),clock.now(),orgId,invoice.id]);
        }
      }
      await tx.query('UPDATE billing_workspace_addons SET auto_renew=?,next_action_at=?,updated_at=? WHERE org_id=? AND id=?',[autoRenew ? 1 : 0,clock.now(),clock.now(),orgId,addonId]);
      return {id:addonId,autoRenew};
    }});
  }

  async function cancelPending({orgId,addonId,context}) {
    return uow.runFinancial({orgId,operationId:context.operationId,requestFingerprint:fingerprint({orgId,addonId,action:'cancel',actor:context.actor.id}),callback:async tx => {
      const addon = (await query(tx,"SELECT id FROM billing_workspace_addons WHERE org_id=? AND id=? AND status='pending' FOR UPDATE",[orgId,addonId]))[0];
      if (!addon) fail('Only a pending purchase can be cancelled.',404);
      if ((await query(tx,`SELECT p.id FROM billing_payment_requests p JOIN billing_workspace_addon_cycles c ON c.org_id=p.org_id AND c.invoice_id=p.invoice_id
        WHERE c.org_id=? AND c.addon_id=? AND p.status IN ('pending_verification','needs_clarification','clarification_requested') LIMIT 1`,[orgId,addonId]))[0]) fail('Resolve the submitted payment before cancelling this purchase.');
      await tx.query(`UPDATE billing_invoices i JOIN billing_workspace_addon_cycles c ON c.org_id=i.org_id AND c.invoice_id=i.id
        SET i.status='void',i.voided_at=?,i.updated_at=?,i.version=i.version+1 WHERE c.org_id=? AND c.addon_id=? AND i.status IN ('open','overdue')`,[clock.now(),clock.now(),orgId,addonId]);
      await tx.query("UPDATE billing_workspace_addons SET status='cancelled',updated_at=?,next_action_at='9999-12-31' WHERE org_id=? AND id=?",[clock.now(),orgId,addonId]);
      return {id:addonId,status:'cancelled'};
    }});
  }

  async function maintainOne(candidate, now) {
    const operationId = `workspace-maintenance:${candidate.id}:${crypto.createHash('sha256').update(iso(candidate.next_action_at)).digest('hex')}`;
    return uow.runLifecycle({orgId:candidate.org_id,operationId,requestFingerprint:fingerprint({id:candidate.id,dueAt:iso(candidate.next_action_at)}),callback:async tx => {
      const addon = (await query(tx,'SELECT * FROM billing_workspace_addons WHERE org_id=? AND id=? FOR UPDATE',[candidate.org_id,candidate.id]))[0];
      if (!addon || iso(addon.next_action_at) !== iso(candidate.next_action_at) || Date.parse(iso(addon.next_action_at)) > Date.parse(now)) return {skipped:true};
      const cycles = await query(tx,`SELECT c.*,i.status AS invoice_status FROM billing_workspace_addon_cycles c
        JOIN billing_invoices i ON i.org_id=c.org_id AND i.id=c.invoice_id WHERE c.org_id=? AND c.addon_id=? ORDER BY c.cycle_index DESC`,[addon.org_id,addon.id]);
      const latest = cycles[0];
      if (addon.status === 'pending') {
        const waiting = latest && (await query(tx,"SELECT id FROM billing_payment_requests WHERE org_id=? AND invoice_id=? AND status IN ('pending_verification','needs_clarification','clarification_requested') LIMIT 1",[addon.org_id,latest.invoice_id]))[0];
        if (!waiting) {
          await tx.query("UPDATE billing_invoices SET status='void',voided_at=?,updated_at=?,version=version+1 WHERE org_id=? AND id=? AND status='open'",[now,now,addon.org_id,latest.invoice_id]);
          await tx.query("UPDATE billing_workspace_addons SET status='cancelled',next_action_at='9999-12-31',updated_at=? WHERE org_id=? AND id=?",[now,addon.org_id,addon.id]);
          return {cancelled:true};
        }
        await tx.query('UPDATE billing_workspace_addons SET next_action_at=?,updated_at=? WHERE org_id=? AND id=?',[shiftDays(now,1),now,addon.org_id,addon.id]);
        return {awaitingReview:true};
      }
      const end = iso(addon.period_ends_at);
      const cutoff = addon.auto_renew ? iso(addon.grace_ends_at) : end;
      if (Date.parse(now) >= Date.parse(cutoff)) {
        await tx.query("UPDATE billing_workspace_addons SET status='suspended' WHERE org_id=? AND id=?",[addon.org_id,addon.id]);
        await tx.query(`UPDATE workspaces SET status='Suspended',settings=JSON_SET(COALESCE(settings,JSON_OBJECT()),'$.billingSuspended',true)
          WHERE org_id=? AND id=? AND status='Active'`,[addon.org_id,addon.workspace_id]);
      }
      if (addon.auto_renew) {
        let invoiceId = latest?.invoice_id;
        if (!latest || latest.paid_at || latest.invoice_status === 'void') {
          const index = latest ? Number(latest.cycle_index)+1 : 0;
          const nextEnd = addCalendarInterval(end,{unit:'month',count:1},{timeZone:'UTC',anchorDay:new Date(addon.anchor_at).getUTCDate()});
          invoiceId = await issueInvoice(tx,addon,{index,startsAt:end,endsAt:nextEnd,now});
        }
        if (Date.parse(now) >= Date.parse(end)) await tx.query("UPDATE billing_invoices SET status='overdue',updated_at=?,version=version+1 WHERE org_id=? AND id=? AND status='open'",[now,addon.org_id,invoiceId]);
      }
      // After invoicing, the next action is grace expiry (or cancellation expiry).
      // Suspended add-ons stop accruing invoices until their one outstanding fee is paid.
      const next = Date.parse(now) >= Date.parse(cutoff) ? '9999-12-31' : Date.parse(now) < Date.parse(end) ? end : cutoff;
      await tx.query('UPDATE billing_workspace_addons SET next_action_at=?,updated_at=? WHERE org_id=? AND id=?',[next,now,addon.org_id,addon.id]);
      return {id:addon.id,suspended:Date.parse(now) >= Date.parse(cutoff)};
    }});
  }

  async function runMaintenance({limit=100} = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError('Maintenance limit must be 1 to 500.');
    const now = clock.now();
    const candidates = rowsOf(await pool.query("SELECT id,org_id,next_action_at FROM billing_workspace_addons WHERE next_action_at<=? AND status<>'cancelled' ORDER BY next_action_at,id LIMIT ?",[now,limit]));
    const results = [];
    for (const candidate of candidates) {
      try { results.push(await maintainOne(candidate,now)); }
      catch (error) { require('../observability/logger').getLogger('billing.workspace-addons').error('Workspace add-on maintenance failed', {addonId:candidate.id,code:error.code}); results.push({id:candidate.id,failed:true}); }
    }
    return {scanned:candidates.length,results};
  }

  return {createPurchase,purchaseWithTopup,availableTopupBalance,applyInvoicePayment,list,changeRenewal,cancelPending,runMaintenance};
}

module.exports = {createWorkspaceAddonBilling,purchasesEnabled,topupRedemptionEnabled,validateWorkspaceInput,monthBoundary,GRACE_DAYS};
