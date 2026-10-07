// Child workspaces stay unavailable until the operator explicitly confirms
// the isolation audit and enables the feature. Both flags are required so a
// normal feature toggle cannot bypass the rollout gate by itself.
function multipleWorkspacesEnabled() {
  return process.env.MULTI_WORKSPACE_ENABLED === "true"
    && process.env.WORKSPACE_ISOLATION_VERIFIED === "true";
}

function workspaceSharingEnabled() {
  return multipleWorkspacesEnabled() && process.env.WORKSPACE_SHARING_ENABLED === "true";
}

module.exports = { multipleWorkspacesEnabled, workspaceSharingEnabled };
