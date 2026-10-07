// Scope is immutable and local to an asynchronous operation. Express requests
// and durable workers must establish it after checking their own authority.
const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
function validateScope(scope) {
  const orgId = typeof scope?.orgId === 'string' ? scope.orgId.trim() : '';
  const workspaceId = typeof scope?.workspaceId === 'string' ? scope.workspaceId.trim() : '';
  if (!orgId || !workspaceId || orgId.length > 191 || workspaceId.length > 191) {
    throw new Error('An organization and workspace are required');
  }
  return Object.freeze({ orgId, workspaceId });
}
function runWithoutScope(operation) { return storage.run(null, operation); }
function getScope() { return storage.getStore() || null; }
function runWithScope(scope, operation) { return storage.run(validateScope(scope), operation); }
function scopeForOrg(orgId) {
  const active = getScope();
  if (active) {
    if (orgId && active.orgId !== orgId) throw new Error('Organization does not match the active workspace');
    return active;
  }
  // Compatibility for existing organization-scoped callers: the initial
  // workspace has the same ID. This never selects an arbitrary child.
  return validateScope({ orgId, workspaceId: orgId });
}
function bindScope(operation, scope = getScope()) {
  return function (...args) {
    const invoke = () => operation.apply(this, args);
    return scope ? runWithScope(scope, invoke) : runWithoutScope(invoke);
  };
}
function onScopedEvent(emitter, event, listener) {
  return emitter.on(event, bindScope(listener));
}
function bindScopedCallbacks(callbacks) {
  return Object.fromEntries(Object.entries(callbacks).map(([key,value]) =>
    [key, typeof value === 'function' ? bindScope(value) : value]));
}
module.exports = { bindScopedCallbacks, validateScope, getScope, runWithScope, runWithoutScope, scopeForOrg, bindScope, onScopedEvent };
