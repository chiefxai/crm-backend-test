const {
  authorization, organizationRole, legacyWorkspaceRole, requestPermission,
  ORGANIZATION_ROLES, WORKSPACE_ROLES,
} = require('../src/authorization/policy');

describe('organization-wide admins are distinct from workspace admins', () => {
  test.each(['Owner','Organization Admin','Super Admin'])(
    '%s never inherits Workspace Admin from its organization role',
    role => {
      expect(legacyWorkspaceRole(role)).toBeNull();
      const orgRole = organizationRole(role);
      expect(ORGANIZATION_ROLES).toContain(orgRole);
      const authority = authorization({ orgRole, workspaceRole: null });
      expect(authority.organizationRole).toBe(orgRole);
      expect(authority.workspaceRole).toBeNull();
      expect(authority.permissions).toContain('organization.members.manage');
      expect(authority.permissions).toContain('billing.credit.allocate');
      expect(authority.permissions).toContain('billing.allocation_rules.manage');
      expect(authority.permissions).not.toContain('workspace.settings.manage');
      expect(authority.permissions).not.toContain('workspace.members.manage');
    },
  );

  test('a Workspace Admin cannot allocate or distribute organization credits', () => {
    expect(WORKSPACE_ROLES).toContain('Workspace Admin');
    const authority = authorization({ orgRole: 'Member', workspaceRole: 'Workspace Admin' });
    expect(authority.permissions).toContain('workspace.members.manage');
    expect(authority.permissions).not.toContain('billing.credit.allocate');
    expect(authority.permissions).not.toContain('billing.allocation_rules.manage');
    const billing = authorization({ orgRole: 'Billing Admin', workspaceRole: null });
    expect(billing.permissions).not.toContain('billing.credit.allocate');
    expect(billing.permissions).not.toContain('billing.allocation_rules.manage');
  });

  test.each([
    ['/api/billing/allocations', 'POST', 'billing.credit.allocate'],
    ['/api/billing/transfers', 'POST', 'billing.credit.allocate'],
    ['/api/billing/allocation-rules', 'PUT', 'billing.allocation_rules.manage'],
    ['/api/billing/allocation-rules', 'GET', 'billing.read'],
  ])('financial route %s %s needs %s', (url, method, permission) => {
    expect(requestPermission({ originalUrl:url, method })).toBe(permission);
  });

  test('explicit workspace assignments retain their own workspace permissions', () => {
    const explicit = authorization({ orgRole:'Organization Admin', workspaceRole:'Manager' });
    expect(explicit.organizationRole).toBe('Organization Admin');
    expect(explicit.workspaceRole).toBe('Manager');
    expect(explicit.permissions).toContain('workspace.write');
    expect(explicit.permissions).not.toContain('workspace.members.manage');
  });
});
