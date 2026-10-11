'use strict';

const { requestPermission } = require('../src/authorization/policy');

function request(path, method = 'GET') {
  return { originalUrl: path, method };
}

test('organization settings reads use organization permissions in the global request gate', () => {
  expect(requestPermission(request('/api/settings/organization/numbers'))).toBe('organization.read');
  expect(requestPermission(request('/api/settings/organization/workspace-access'))).toBe('organization.members.read');
  expect(requestPermission(request('/api/settings/organization/workspace-access/ws-1/member-1', 'PUT')))
    .toBe('organization.members.manage');
});
