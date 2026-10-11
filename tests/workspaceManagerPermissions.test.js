'use strict';

jest.mock('../src/db/repositories/workspaceRepository', () => ({ getActive: jest.fn() }));
jest.mock('../src/platform/featureFlags', () => ({
  getEnabledAppFeatureKeys: jest.fn(async () => ['leads','reports']),
  isAppFeatureEnabled: jest.fn(async () => true),
}));

const workspaceRepository = require('../src/db/repositories/workspaceRepository');
const { authorization, requestPermission } = require('../src/authorization/policy');
const { assignableKeys } = require('../src/authorization/workspaceFeatures');

test('Managers can manage workspace members but ordinary Members cannot', () => {
  const manager = authorization({ orgRole:'Member',workspaceRole:'Manager' });
  const member = authorization({ orgRole:'Member',workspaceRole:'Member' });
  const workspaceAdmin = authorization({ orgRole:'Member',workspaceRole:'Workspace Admin' });

  expect(manager.permissions).toContain('workspace.members.manage');
  expect(manager.permissions).not.toContain('organization.members.manage');
  expect(member.permissions).not.toContain('workspace.members.manage');
  expect(workspaceAdmin.permissions).toContain('workspace.members.manage');
});

test('workspace-scoped member create and delete defer authorization to scoped route checks', () => {
  expect(requestPermission({ originalUrl:'/api/settings/team',method:'POST' })).toBeNull();
  expect(requestPermission({ originalUrl:'/api/settings/team/member-1',method:'DELETE' })).toBeNull();
});

test('Managers can grant only features they have in their current workspace', async () => {
  workspaceRepository.getActive.mockResolvedValue({ settings:{enabledFeatures:['leads','reports']} });
  const keys = await assignableKeys({
    orgId:'org-1',workspaceId:'workspace-1',orgFeatureFlags:['leads','reports'],
    memberFeatureFlags:['reports'],authorization:{workspaceRole:'Manager'},
  });
  expect(keys).toEqual(['reports']);
});
