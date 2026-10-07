const { getScope } = require('../workspaces/scope');
function recordingKey(callId) {
  const scope = getScope();
  const name = encodeURIComponent(String(callId)) + '.wav';
  // Preserve historical default URLs; child recordings always have an
  // explicit owner in their object key as well as their database row.
  if (!scope || scope.workspaceId === scope.orgId) return `recordings/${name}`;
  return `recordings/${encodeURIComponent(scope.orgId)}/${encodeURIComponent(scope.workspaceId)}/${name}`;
}
module.exports = { recordingKey };
