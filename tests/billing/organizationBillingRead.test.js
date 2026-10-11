'use strict';

const { authorization, requestPermission } = require('../../src/authorization/policy');

function request(path, method = 'GET') {
  return { originalUrl: path, method };
}

test.each([
  '/api/billing',
  '/api/billing/console',
  '/api/billing/legacy-overview',
  '/api/billing/overview',
  '/api/billing/payments',
  '/api/billing/workspace-addons',
])('%s is classified as an organization financial read', (path) => {
  expect(requestPermission(request(path))).toBe('billing.organization.read');
});

test('organization financial reads reject workspace-only billing administrators', () => {
  const workspaceAdmin = authorization({ orgRole: 'Member', workspaceRole: 'Workspace Admin' });
  const organizationBillingAdmin = authorization({ orgRole: 'Billing Admin', workspaceRole: null });

  expect(workspaceAdmin.permissions).toContain('billing.read');
  expect(workspaceAdmin.permissions).not.toContain('billing.organization.read');
  expect(organizationBillingAdmin.permissions).toContain('billing.organization.read');
});

test('workspace usage and workspace budget keep their workspace permissions', () => {
  expect(requestPermission(request('/api/ai-usage'))).toBe('billing.read');
  expect(requestPermission(request('/api/billing/workspace-budget', 'PATCH'))).toBe('workspace.settings.manage');
  expect(requestPermission(request('/api/billing/payments', 'POST'))).toBe('billing.read');
});

