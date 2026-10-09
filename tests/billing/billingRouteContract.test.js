'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Static route contract checks do not require credentials, DB access, or
// a running server. HTTP integration tests must additionally exercise auth.
const routes = fs.readFileSync(path.join(__dirname, '../../src/routes/billing.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../../src/routes/index.js'), 'utf8');

test('billing router is mounted under /api/billing', () => {
  assert.match(index, /router\.use\(["']\/api\/billing["'], require\(["']\.\/billing["']\)\)/);
});

test('legacy billing overview is protected by authentication and billing.read', () => {
  assert.match(routes, /router\.get\(['"]\/legacy-overview['"],\s*requireAuth,\s*requirePermission\(['"]billing\.read['"]\)/);
  assert.match(routes, /getOrganizationBillingConsole\(req\.orgId\)/);
});

test('new overview is scoped, authenticated, and uses the ledger read model', () => {
  assert.match(routes, /router\.get\(['"]\/overview['"],\s*requireAuth,\s*requirePermission\(['"]billing\.read['"]\)/);
  assert.match(routes, /readBillingOverview\(req\.orgId\)/);
  assert.match(routes, /BILLING_ACCOUNT_NOT_INITIALIZED/);
});
