'use strict';

const { assertTransactionContext } = require('../../../kernel/transactionContext');
const { validateId } = require('../../../kernel/scope');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');
const { mapUsageEvent } = require('./mysqlUsageEventRepository');

function rowsOf(value) { const result = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value; return Array.isArray(result) ? result : result?.rows || []; }
function assertOrg(tx, orgId) { assertTransactionContext(tx); validateId(orgId, 'orgId'); if (tx.metadata?.orgId !== orgId) throw new TypeError('Usage settlement organization must match transaction organization.'); }

function createMysqlSettlementRepository() {
  async function getPreviousRevision(tx, event) {
    assertOrg(tx, event.orgId);
    const row = rowsOf(await tx.query(`SELECT id,org_id,workspace_id,period_id,source_type,source_id,component_key,revision,event_status,
        quantity_units,quantity_scale,amount_units,asset,scale,pricing_schema_version,pricing_snapshot_json,occurred_at,recorded_at
      FROM billing_usage_events WHERE org_id=? AND source_type=? AND source_id=? AND component_key=? AND revision<?
      ORDER BY revision DESC LIMIT 1 FOR UPDATE`, [event.orgId, event.sourceType, event.sourceId, event.componentKey, event.revision]))[0];
    return mapUsageEvent(row);
  }

  async function getPriorRevisionIds(tx, event) {
    assertOrg(tx, event.orgId);
    return rowsOf(await tx.query(`SELECT id FROM billing_usage_events WHERE org_id=? AND source_type=? AND source_id=? AND component_key=? AND revision<? ORDER BY revision`,
    [event.orgId, event.sourceType, event.sourceId, event.componentKey, event.revision])).map((row) => row.id);
  }

  async function hasSettlement(tx, { orgId, eventId }) {
    assertOrg(tx, orgId); validateId(eventId, 'eventId');
    const credit = rowsOf(await tx.query(`SELECT id FROM billing_journals WHERE org_id=? AND source_type IN ('usage_event','usage_event_revision') AND source_id=? LIMIT 1 FOR UPDATE`, [orgId, eventId]))[0];
    if (credit) return true;
    return Boolean(rowsOf(await tx.query(`SELECT id FROM billing_postpaid_journals WHERE org_id=? AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.eventId'))=? LIMIT 1 FOR UPDATE`, [orgId, eventId]))[0]);
  }

  async function getCreditCharges(tx, { orgId, eventId }) {
    assertOrg(tx, orgId);
    return rowsOf(await tx.query(`SELECT j.id AS journal_id,j.operation_id,j.operation_type,j.source_type,j.source_id,j.actor_type,j.actor_id,j.reason,j.created_at,
        l.line_number,l.account_id,l.grant_id,l.entry_type,l.amount_units,l.asset,l.scale
      FROM billing_journals j INNER JOIN billing_journal_lines l ON l.org_id=j.org_id AND l.journal_id=j.id
      WHERE j.org_id=? AND j.source_type='usage_event' AND j.source_id=? AND j.operation_type='credit_consume'
      ORDER BY j.created_at DESC,j.id DESC,l.line_number`, [orgId, eventId]));
  }

  async function getCreditChargesForEvents(tx, { orgId, eventIds }) {
    assertOrg(tx, orgId);
    if (!Array.isArray(eventIds) || !eventIds.length) return [];
    eventIds.forEach((eventId) => validateId(eventId, 'eventId'));
    return rowsOf(await tx.query(`SELECT j.id AS journal_id,j.operation_id,j.operation_type,j.source_type,j.source_id,j.actor_type,j.actor_id,j.reason,j.created_at,
        l.line_number,l.account_id,l.grant_id,l.entry_type,l.amount_units,l.asset,l.scale
      FROM billing_journals j INNER JOIN billing_journal_lines l ON l.org_id=j.org_id AND l.journal_id=j.id
      WHERE j.org_id=? AND j.source_type IN ('usage_event','usage_event_revision') AND j.source_id IN (${eventIds.map(() => '?').join(',')})
        AND j.operation_type IN ('credit_consume','credit_consume_reversal') ORDER BY j.created_at DESC,j.id DESC,l.line_number`, [orgId, ...eventIds]));
  }

  async function getPostpaidCharges(tx, { orgId, eventId }) {
    assertOrg(tx, orgId);
    return rowsOf(await tx.query(`SELECT id,workspace_id,period_id,reservation_id,operation_id,entry_key,entry_type,amount_units,asset,scale,reversal_of_id,metadata_json
      FROM billing_postpaid_journals WHERE org_id=? AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.eventId'))=? ORDER BY created_at DESC,id DESC FOR UPDATE`, [orgId, eventId]));
  }

  async function getPostpaidChargesForEvents(tx, { orgId, eventIds }) {
    assertOrg(tx, orgId);
    if (!Array.isArray(eventIds) || !eventIds.length) return [];
    eventIds.forEach((eventId) => validateId(eventId, 'eventId'));
    return rowsOf(await tx.query(`SELECT id,workspace_id,period_id,reservation_id,operation_id,entry_key,entry_type,amount_units,asset,scale,reversal_of_id,metadata_json
      FROM billing_postpaid_journals WHERE org_id=? AND entry_type IN ('usage_charge','usage_adjustment')
        AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.eventId')) IN (${eventIds.map(() => '?').join(',')})
      ORDER BY created_at DESC,id DESC FOR UPDATE`, [orgId, ...eventIds]));
  }

  async function getInvoiceSourceLines(tx, { orgId, sourceType, sourceId }) {
    assertOrg(tx, orgId);
    return rowsOf(await tx.query(`SELECT l.id,l.invoice_id,l.line_key,l.workspace_id,l.amount_units,l.asset,l.scale,l.line_snapshot_json,i.status AS invoice_status
      FROM billing_invoice_lines l INNER JOIN billing_invoices i ON i.org_id=l.org_id AND i.id=l.invoice_id
      WHERE l.org_id=? AND l.source_type=? AND l.source_id=? FOR UPDATE`, [orgId, sourceType, sourceId]));
  }

  return Object.freeze({ getPreviousRevision, getPriorRevisionIds, hasSettlement, getCreditCharges, getCreditChargesForEvents, getPostpaidCharges, getPostpaidChargesForEvents, getInvoiceSourceLines });
}

module.exports = { createMysqlSettlementRepository };
