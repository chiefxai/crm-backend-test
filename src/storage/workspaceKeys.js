const { getScope } = require('../workspaces/scope');
function recordingKey(callId) {
  const scope = getScope();
  if (!scope) throw new Error('Recording uploads require an active organization and workspace scope.');
  const name = encodeURIComponent(String(callId)) + '.wav';
  return `orgs/${encodeURIComponent(scope.orgId)}/recordings/${encodeURIComponent(scope.workspaceId)}/${name}`;
}
module.exports = { recordingKey };
