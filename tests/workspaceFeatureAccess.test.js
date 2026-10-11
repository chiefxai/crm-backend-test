jest.mock('../src/db/repositories/workspaceRepository', () => ({ getActive: jest.fn() }));
jest.mock('../src/platform/featureFlags', () => ({
  getEnabledAppFeatureKeys: jest.fn(async () => ['leads','reports']),
  isAppFeatureEnabled: jest.fn(async () => true),
}));
const workspaceRepository = require('../src/db/repositories/workspaceRepository');
const platformFeatures = require('../src/platform/featureFlags');
const { mappedFeature, enforceFeatureRequest, effectiveKeys } = require('../src/authorization/workspaceFeatures');

function invoke({ granted, member = ['leads'], org = ['leads'], role = 'Member', url = '/api/leads', override = null } = {}) {
  const req = { orgId:'org-a',workspaceId:'branch-b',originalUrl:url,
    orgFeatureFlags:org,memberFeatureFlags:member,
    workspaceMemberFeatureOverride:override,authorization:{workspaceRole:role} };
  workspaceRepository.getActive.mockResolvedValue({ settings: granted === null ? {} : {enabledFeatures:granted} });
  const res = { status:jest.fn().mockReturnThis(),json:jest.fn() };
  const next = jest.fn();
  return enforceFeatureRequest(req,res,next).then(() => ({req,res,next}));
}

beforeEach(() => {
  jest.clearAllMocks();
  platformFeatures.isAppFeatureEnabled.mockResolvedValue(true);
});
test('legacy workspaces keep existing routes without explicit workspace feature policy', async () => {
  const {res,next} = await invoke({granted:null});
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.status).not.toHaveBeenCalled();
});
test('newly configured empty workspace policy denies feature routes', async () => {
  const {res,next} = await invoke({granted:[]});
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});
test('all three grants and platform switch must allow a feature', async () => {
  const allowed = await invoke({granted:['leads']});
  expect(allowed.next).toHaveBeenCalledTimes(1);
  const noOrg = await invoke({granted:['leads'],org:[]});
  expect(noOrg.res.status).toHaveBeenCalledWith(403);
  const noMember = await invoke({granted:['leads'],member:[]});
  expect(noMember.res.status).toHaveBeenCalledWith(403);
  platformFeatures.isAppFeatureEnabled.mockResolvedValue(false);
  const globallyDisabled = await invoke({granted:['leads']});
  expect(globallyDisabled.res.status).toHaveBeenCalledWith(403);
});
test('workspace administrators still cannot exceed org or workspace feature limits', async () => {
  expect((await invoke({granted:['leads'],member:[],role:'Workspace Admin'})).next).toHaveBeenCalled();
  expect((await invoke({granted:[],member:['leads'],role:'Workspace Admin'})).res.status).toHaveBeenCalledWith(403);
  expect((await invoke({granted:['leads'],org:[],role:'Workspace Admin'})).res.status).toHaveBeenCalledWith(403);
});
test('feature middleware fetches policy within the selected org and workspace', async () => {
  await invoke({granted:['leads']});
  expect(workspaceRepository.getActive).toHaveBeenCalledWith('org-a','branch-b');
});
test('unmapped organization administration routes are unaffected', async () => {
  const {next} = await invoke({granted:[],url:'/api/settings/organization/workspace-features'});
  expect(next).toHaveBeenCalledTimes(1);
  expect(workspaceRepository.getActive).not.toHaveBeenCalled();
});
test('effective keys honor organization and member ceiling', async () => {
  expect(await effectiveKeys(['leads','reports'], ['leads'],['reports','leads'])).toEqual(['leads']);
  expect(await effectiveKeys(['leads'],[],['leads'],true)).toEqual([]);
});
test('common dialing, reporting, and workflow paths are mapped', () => {
  expect(mappedFeature('/api/dialer-tasks')).toBe('dialer');
  expect(mappedFeature('/api/question-flows')).toBe('workflows');
  expect(mappedFeature('/api/audit-log')).toBe('audit_log');
});

test('a member can have different explicit feature access in each workspace', async () => {
  const inWorkspaceA = await invoke({ granted:['leads'],member:[],override:['leads'] });
  expect(inWorkspaceA.next).toHaveBeenCalledTimes(1);
  const inWorkspaceB = await invoke({ granted:['leads'],member:['leads'],override:[] });
  expect(inWorkspaceB.res.status).toHaveBeenCalledWith(403);
  // Inherited grants continue to behave as before.
  const inherited = await invoke({ granted:['leads'],member:['leads'],override:null });
  expect(inherited.next).toHaveBeenCalledTimes(1);
});
test('workspace feature ceilings and explicit empty overrides are enforced for admins', async () => {
  expect((await invoke({ granted:['leads'],override:[],role:'Workspace Admin' })).res.status).toHaveBeenCalledWith(403);
  expect((await invoke({ granted:[],override:['leads'],role:'Workspace Admin' })).res.status).toHaveBeenCalledWith(403);
  expect((await invoke({ granted:['leads'],org:[],override:['leads'] })).res.status).toHaveBeenCalledWith(403);
  expect((await invoke({ granted:null,org:['leads'],member:[],override:['leads'] })).next).toHaveBeenCalled();
  expect((await invoke({ granted:null,org:['leads'],member:['leads'],override:[] })).res.status).toHaveBeenCalledWith(403);
  expect(await effectiveKeys(['leads','reports'],['leads'],['reports'],false,['leads'])).toEqual(['leads']);
  expect(await effectiveKeys(['leads'],['leads'],['leads'],true,[])).toEqual([]);
});
