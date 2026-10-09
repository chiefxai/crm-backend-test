// Workspace feature grants are a restriction layer, never an entitlement grant.
// Null = legacy unconfigured workspace (preserve existing behavior).
// [] = explicitly deny all mapped product features.
const workspaceRepository = require('../db/repositories/workspaceRepository');
const platformFeatures = require('../platform/featureFlags');

const FEATURE_PATHS = [
  [/^\/api\/dashboard(?:\/|$)/, 'executive_desk'],
  [/^\/api\/leads(?:\/|$)/, 'leads'],
  [/^\/api\/contact-groups(?:\/|$)/, 'contact_directory'],
  [/^\/api\/enquiries(?:\/|$)/, 'enquiries'],
  [/^\/api\/loans(?:\/|$)/, 'loan_lifecycle'],
  [/^\/api\/objects(?:\/|$)/, 'objects'],
  [/^\/api\/knowledge(?:\/|$)/, 'knowledge_base'],
  [/^\/api\/agents(?:\/|$)/, 'agent_studio'],
  [/^\/api\/compliance(?:\/|$)/, 'compliance'],
  [/^\/api\/call-logs(?:\/|$)/, 'call_logs'],
  [/^\/api\/calls(?:\/|$)/, 'call_logs'],
  [/^\/api\/ai-usage(?:\/|$)/, 'reports'],
  [/^\/api\/campaigns(?:\/|$)/, 'ai_campaigns'],
  [/^\/api\/workflows(?:\/|$)/, 'workflows'],
  [/^\/api\/dialer(?:\/|$)/, 'dialer'],
  [/^\/api\/dialer-tasks(?:\/|$)/, 'dialer'],
  [/^\/api\/dialer-retries(?:\/|$)/, 'dialer'],
  [/^\/api\/question-flows(?:\/|$)/, 'workflows'],
  [/^\/api\/audit-log(?:\/|$)/, 'audit_log'],
  [/^\/api\/conversations(?:\/|$)/, 'unified_inbox'],
];

function mappedFeature(originalUrl) {
  const pathname = new URL(originalUrl || '/', 'http://local').pathname.toLowerCase();
  return FEATURE_PATHS.find(([pattern]) => pattern.test(pathname))?.[1] || null;
}
async function listWorkspaceGrants(orgId, workspaceId) {
  const workspace = await workspaceRepository.getActive(orgId, workspaceId);
  if (!workspace) return null;
  const value = workspace.settings?.enabledFeatures;
  return Array.isArray(value) ? value.filter(v => typeof v === 'string') : null;
}
async function effectiveKeys(orgKeys, workspaceKeys, memberKeys, isWorkspaceAdmin = false) {
  const globallyEnabled = new Set(await platformFeatures.getEnabledAppFeatureKeys());
  const org = new Set(orgKeys.filter(k => globallyEnabled.has(k)));
  const workspace = workspaceKeys === null ? org : new Set(workspaceKeys.filter(k => org.has(k)));
  if (isWorkspaceAdmin) return [...workspace];
  const member = new Set(memberKeys);
  return [...workspace].filter(k => member.has(k));
}
async function enforceFeatureRequest(req, res, next) {
  const key = mappedFeature(req.originalUrl || req.url);
  if (!key || !req.orgId || !req.workspaceId) return next();
  try {
    const grants = await listWorkspaceGrants(req.orgId, req.workspaceId);
    if (grants === null) return next(); // no policy configured: migration-safe
    const isWorkspaceAdmin = req.authorization?.workspaceRole === 'Workspace Admin' || req.authorization?.platformAdmin === true;
    const permitted = grants.includes(key)
      && Array.isArray(req.orgFeatureFlags) && req.orgFeatureFlags.includes(key)
      && (isWorkspaceAdmin || (Array.isArray(req.memberFeatureFlags) && req.memberFeatureFlags.includes(key)))
      && await platformFeatures.isAppFeatureEnabled(key);
    if (!permitted) return res.status(403).json({ error: 'Feature disabled for this workspace', feature: key });
    next();
  } catch (error) { next(error); }
}
module.exports = { mappedFeature, listWorkspaceGrants, effectiveKeys, enforceFeatureRequest };
