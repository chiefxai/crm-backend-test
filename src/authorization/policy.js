const { AsyncLocalStorage } = require('node:async_hooks');
const requestAuthority = new AsyncLocalStorage();
// Organization privileges never imply access to operational workspace data.
const ORGANIZATION_ROLES = ['Owner','Organization Admin','Billing Admin','Member'];
const WORKSPACE_ROLES = ['Workspace Admin','Manager','Member','Viewer'];
const ORG_PERMISSIONS = {
  Owner: ['organization.read','organization.manage','organization.members.read','organization.members.manage','billing.read'],
  'Organization Admin': ['organization.read','organization.manage','organization.members.read','organization.members.manage','billing.read'],
  'Billing Admin': ['organization.read','billing.read'],
  Member: [],
};
const WORKSPACE_PERMISSIONS = {
  'Workspace Admin': ['workspace.read','workspace.write','workspace.delete','workspace.settings.manage','workspace.members.manage','workspace.audit.read','workspace.call'],
  Manager: ['workspace.read','workspace.write','workspace.delete','workspace.call'],
  Member: ['workspace.read','workspace.write','workspace.call'],
  Viewer: ['workspace.read'],
};
function organizationRole(role) {
  // Legacy customer Super Admin is an organization administrator. Platform
  // authority comes exclusively from the verified identity, never this field.
  if (role === 'Super Admin') return 'Organization Admin';
  return ORGANIZATION_ROLES.includes(role) ? role : 'Member';
}
function legacyWorkspaceRole(role) {
  if (['Owner','Organization Admin','Super Admin','Workspace Admin'].includes(role)) return 'Workspace Admin';
  if (['Manager','Sales Manager'].includes(role)) return 'Manager';
  if (['Viewer','Customer'].includes(role)) return 'Viewer';
  if (role === 'Billing Admin') return null;
  return 'Member';
}
function authorization({ orgRole, workspaceRole, platformAdmin = false }) {
  const permissions = platformAdmin ? [...new Set([...Object.values(ORG_PERMISSIONS).flat(),...Object.values(WORKSPACE_PERMISSIONS).flat(),'platform.manage'])]
    : [...new Set([...(ORG_PERMISSIONS[orgRole] || []),...(WORKSPACE_PERMISSIONS[workspaceRole] || [])])];
  return { organizationRole: orgRole, workspaceRole: workspaceRole || null, platformAdmin, permissions };
}
function hasPermission(req, permission) { return req.authorization?.permissions.includes(permission) === true; }
function requirePermission(permission) {
  return (req,res,next) => hasPermission(req,permission) ? next() : res.status(403).json({ error: 'Permission denied', permission });
}
function requestPermission(req) {
  const path = new URL(req.originalUrl || req.url,'http://local').pathname.toLowerCase().replace(/\/+$/,'');
  const read = ['GET','HEAD','OPTIONS'].includes(req.method);
  if (['/api/auth/me','/api/auth/roles','/api/settings/me'].includes(path)) return null;
  if (/^\/api\/billing(?:\/|$)/.test(path) || /^\/api\/ai-usage(?:\/|$)/.test(path)) return 'billing.read';
  if (/^\/api\/settings\/team(?:\/|$)/.test(path)) return read ? 'organization.members.read' : 'organization.members.manage';
  if (path === '/api/settings/org') return read ? 'organization.read' : 'organization.manage';
  if (path === '/api/metrics' || path === '/api/list-models') return 'platform.manage';
  if (path === '/api/audit-log') return 'workspace.audit.read';
  if (path === '/api/logs-stream/ticket') return 'workspace.read';
  if (path === '/api/voice-session/ticket' || /^\/api\/(vobiz|twilio|telecmi|piopiy)\/(call|hangup)$/.test(path) || ['/api/simulate-call','/api/gemini/simulate-call','/api/config/preview'].includes(path)) return 'workspace.call';
  if (!read && (/^\/api\/(config|agents|channels|knowledge)(?:\/|$)/.test(path) || /^\/api\/settings\/(workspace|numbers|vobiz-inbound-webhook)(?:\/|$)/.test(path))) return 'workspace.settings.manage';
  if (req.method === 'DELETE') return 'workspace.delete';
  return read ? 'workspace.read' : 'workspace.write';
}
function enforceRequest(req,res,next) {
  const permission = requestPermission(req);
  if (permission && !hasPermission(req,permission)) return res.status(403).json({ error: 'Permission denied',permission });
  return requestAuthority.run({ ...req.authorization,orgId: req.orgId,workspaceId: req.workspaceId },next);
}
module.exports = { getRequestAuthority: () => requestAuthority.getStore(), ORGANIZATION_ROLES,WORKSPACE_ROLES,organizationRole,legacyWorkspaceRole,authorization,hasPermission,requirePermission,requestPermission,enforceRequest };
