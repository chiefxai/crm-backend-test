const { getScope, validateScope, runWithScope, runWithoutScope } = require('../workspaces/scope');

// Scope travels in the durable job envelope, independent of the originating
// process or browser tab. The facade overwrites caller-supplied metadata.
function scopeJobData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    if (getScope()) throw new Error('Scoped jobs require an object payload');
    return data;
  }
  const active = getScope();
  const candidate = active || (data.orgId ? { orgId: data.orgId, workspaceId: data.workspaceId || data.orgId } : null);
  if (!candidate) {
    const { _workspaceScope, ...unscoped } = data;
    return unscoped;
  }
  const scope = validateScope(candidate);
  if ((data.orgId && data.orgId !== scope.orgId) || (data.workspaceId && data.workspaceId !== scope.workspaceId)) {
    throw new Error('Queued job does not match the active workspace');
  }
  return { ...data, workspaceId: scope.workspaceId, _workspaceScope: scope };
}
function wrapWorkspaceQueue(adapter) {
  return {
    ...adapter,
    enqueue(type, data, ...args) { return adapter.enqueue(type, scopeJobData(data), ...args); },
    process(type, handler, ...options) {
      return adapter.process(type, (...args) => {
        const data = args[0];
        const candidate = data?._workspaceScope || (data?.orgId ? { orgId: data.orgId, workspaceId: data.workspaceId || data.orgId } : null);
        if (!candidate) return runWithoutScope(() => handler(...args));
        const scope = validateScope(candidate);
        if ((data.orgId && data.orgId !== scope.orgId) || (data.workspaceId && data.workspaceId !== scope.workspaceId)) {
          throw new Error('Invalid workspace in durable job envelope');
        }
        return runWithScope(scope, () => handler(...args));
      }, ...options);
    },
  };
}
module.exports = { wrapWorkspaceQueue };
