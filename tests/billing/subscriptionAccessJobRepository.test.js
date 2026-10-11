'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMysqlSubscriptionAccessJobRepository } = require('../../src/billing/adapters/jobs/subscriptionAccess/mysqlSubscriptionAccessJobRepository');

test('subscription access scan is bounded, cursorable, and only selects billing-access candidates', async () => {
  const calls = [];
  const pool = { async connect() { return {
    async query(sql, params) { calls.push({ sql, params }); return { rows: [{ org_id: 'org-1', billing_access_state: 'operational',
      billing_suspension_cause: null, restriction_deadline: '2026-10-11 10:00:00.000000', version: '2' }] }; },
    release() { calls.push({ release: true }); },
  }; } };
  const repo = createMysqlSubscriptionAccessJobRepository({ pool });
  const result = await repo.listDueAccessRestrictions({ now: '2026-10-11T12:00:00.000Z', limit: 10, afterOrgId: 'org-0' });
  assert.match(calls[0].sql, /restriction_deadline<=\?/);
  assert.match(calls[0].sql, /billing_access_state IN \('operational','billing_recovery'\)/);
  assert.match(calls[0].sql, /org_id>\?/);
  assert.deepEqual(calls[0].params, ['2026-10-11T12:00:00.000Z', 'org-0', 10]);
  assert.deepEqual(result[0], { orgId: 'org-1', billingAccessState: 'operational', billingSuspensionCause: null,
    restrictionDeadline: '2026-10-11T10:00:00.000Z', version: 2 });
  assert.deepEqual(calls.at(-1), { release: true });
});

test('subscription access scan rejects unbounded limits', async () => {
  const repo = createMysqlSubscriptionAccessJobRepository({ pool: { connect() { throw new Error('must not connect'); } } });
  await assert.rejects(() => repo.listDueAccessRestrictions({ now: '2026-10-11T12:00:00Z', limit: 501 }), /limit/);
});
