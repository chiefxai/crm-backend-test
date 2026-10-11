'use strict';

const { shiftCalendarDays } = require('./modules/subscriptions/periodMath');

function rowsOf(value) { return Array.isArray(value) && Array.isArray(value[0]) ? value[0] : Array.isArray(value) ? value : value?.rows || []; }
function dateIso(value) {
  if (value == null) return null;
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(raw) ? `${raw.replace(' ', 'T').replace(/(\.\d{3})\d+$/, '$1')}Z` : raw;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Stored grace request date is invalid.');
  return date.toISOString();
}

async function listGraceRequests(pool, { orgId, status = 'requested', limit = 50 } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('Grace request read model requires a SQL pool.');
  const bounded = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
  if (status !== 'all' && !['requested', 'approved', 'denied', 'revoked'].includes(status)) throw new TypeError('Invalid grace request status.');
  const where = [];
  const params = [];
  if (orgId) { where.push('g.org_id=?'); params.push(orgId); }
  if (status !== 'all') { where.push('g.status=?'); params.push(status); }
  params.push(bounded);
  const result = await pool.query(
    `SELECT g.id,g.org_id,g.period_id,g.requested_until,g.justification,g.requested_by,g.status,g.granted_until,g.version,g.created_at,g.updated_at,
            p.starts_at AS period_starts_at,p.ends_at AS period_ends_at,o.name AS organization_name
       FROM billing_subscription_grace_requests g
       JOIN billing_periods p ON p.org_id=g.org_id AND p.id=g.period_id
       LEFT JOIN organizations o ON o.id=g.org_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE g.status WHEN 'requested' THEN 0 ELSE 1 END,g.created_at ASC,g.id ASC LIMIT ?`, params);
  const requests = rowsOf(result);
  const decisionsByRequest = new Map();
  if (requests.length) {
    const ids = requests.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(',');
    const orgScope = orgId ? 'org_id=? AND ' : '';
    const decisionParams = orgId ? [orgId, ...ids] : ids;
    const decisions = await pool.query(
      `SELECT grace_request_id,sequence_no,decision,reason,decided_by,granted_until,expected_version,decided_at
         FROM billing_subscription_grace_decisions WHERE ${orgScope}grace_request_id IN (${placeholders})
        ORDER BY grace_request_id,sequence_no`, decisionParams);
    for (const decision of rowsOf(decisions)) {
      const history = decisionsByRequest.get(decision.grace_request_id) || [];
      history.push(Object.freeze({ sequence: Number(decision.sequence_no), decision: decision.decision,
        reason: decision.reason, decidedBy: decision.decided_by, grantedUntil: dateIso(decision.granted_until),
        expectedVersion: Number(decision.expected_version), decidedAt: dateIso(decision.decided_at) }));
      decisionsByRequest.set(decision.grace_request_id, history);
    }
  }
  return Object.freeze(requests.map((row) => Object.freeze({ id: row.id, orgId: row.org_id, organizationName: row.organization_name || null,
    periodId: row.period_id, periodStartsAt: row.period_starts_at, periodEndsAt: row.period_ends_at,
    requestedUntil: row.requested_until, justification: row.justification, requestedBy: row.requested_by,
    status: row.status, grantedUntil: row.granted_until, version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at,
    decisions: Object.freeze(decisionsByRequest.get(row.id) || []) })));
}

async function readOrganizationGraceEligibility(pool, { orgId, maxDaysPerPeriod = 7, billingTimeZone = 'UTC' } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('Grace request read model requires a SQL pool.');
  const result = await pool.query(
    `SELECT s.current_period_id,s.version,s.billing_access_state,s.billing_suspension_cause,s.restriction_deadline,
            p.ends_at AS period_ends_at,p.status AS period_status,
            g.id AS grace_request_id,g.requested_until,g.justification,g.status AS grace_status,g.granted_until,g.version AS grace_version
       FROM organization_subscriptions s
       LEFT JOIN billing_periods p ON p.org_id=s.org_id AND p.id=s.current_period_id
       LEFT JOIN billing_subscription_grace_requests g ON g.org_id=s.org_id AND g.period_id=s.current_period_id
      WHERE s.org_id=? LIMIT 1`, [orgId]);
  const row = rowsOf(result)[0];
  if (!row) return null;
  const periodEnd = dateIso(row.period_ends_at);
  const restrictionDeadline = dateIso(row.restriction_deadline);
  const base = !periodEnd ? null : restrictionDeadline && Date.parse(restrictionDeadline) > Date.parse(periodEnd) ? restrictionDeadline : periodEnd;
  const maximumUntil = base ? shiftCalendarDays(base, Math.max(0, maxDaysPerPeriod), { timeZone: billingTimeZone }) : null;
  const currentRequest = row.grace_request_id ? Object.freeze({ id: row.grace_request_id, requestedUntil: dateIso(row.requested_until),
    justification: row.justification, status: row.grace_status, grantedUntil: dateIso(row.granted_until),
    version: Number(row.grace_version) }) : null;
  return Object.freeze({ subscriptionVersion: Number(row.version), currentPeriodId: row.current_period_id || null,
    billingAccessState: row.billing_access_state, billingSuspensionCause: row.billing_suspension_cause || null,
    currentPeriodEndsAt: periodEnd, currentRestrictionDeadline: restrictionDeadline,
    maxDaysPerPeriod, maximumUntil,
    requestEligible: Boolean(row.current_period_id && periodEnd && ['active', 'scheduled'].includes(String(row.period_status).toLowerCase())
      && !currentRequest && maxDaysPerPeriod > 0), currentRequest });
}

module.exports = { listGraceRequests, readOrganizationGraceEligibility };
