'use strict';

const scope = require('../../../src/billing/kernel/scope');

describe('billing scope kernel', () => {
  test('constructs explicit organization and workspace owners', () => {
    expect(scope.organizationScope('org-1')).toEqual({ orgId: 'org-1', ownerType: 'organization', ownerId: 'org-1' });
    expect(scope.workspaceScope('org-1', 'workspace-2')).toEqual({ orgId: 'org-1', ownerType: 'workspace', ownerId: 'workspace-2' });
  });

  test('accepts the legacy workspace identifier that equals its organization', () => {
    expect(scope.workspaceScope('org-1', 'org-1').ownerType).toBe('workspace');
  });

  test('rejects invalid IDs, arbitrary owners, implicit workspace fields and ownership mismatch', () => {
    expect(() => scope.organizationScope('../org')).toThrow(expect.objectContaining({ code: 'INVALID_BILLING_ID' }));
    expect(() => scope.validateScope({ orgId: 'org-1', ownerType: 'project', ownerId: 'p-1' })).toThrow(expect.objectContaining({ code: 'INVALID_BILLING_OWNER_TYPE' }));
    expect(() => scope.validateScope({ orgId: 'org-1', ownerType: 'organization', ownerId: 'org-2' })).toThrow(expect.objectContaining({ code: 'INVALID_BILLING_OWNERSHIP' }));
    expect(() => scope.validateScope({ orgId: 'org-1', ownerType: 'workspace', ownerId: 'ws-1', workspaceId: 'ws-1' })).toThrow();
  });
});
