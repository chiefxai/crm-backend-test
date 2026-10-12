'use strict';

const fs = require('fs');
const path = require('path');
const migration = require('../../../src/db/migrations/2026100733-normalize-trial-access-state');

test('normalizes existing active trial subscriptions and registers the repair migration', () => {
  expect(migration.id).toBe('2026100733_normalize_trial_access_state');
  const sql = migration.steps.map((step) => step.sql).join('\n');
  expect(sql).toContain("SET billing_access_state='operational'");
  expect(sql).toContain("WHERE billing_access_state='active'");
  expect(sql).toContain("lifecycle_status='active'");
  expect(sql).toContain('current_period_id IS NOT NULL');
  const registry = fs.readFileSync(path.join(__dirname, '../../../src/db/migrations/index.js'), 'utf8');
  expect(registry).toContain('require("./2026100732-telephony-number-org-allocations"), require("./2026100733-normalize-trial-access-state")');
});
