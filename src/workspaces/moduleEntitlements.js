const { effectivePolicy } = require('./organizationPolicy');
const { getIndustryDefinition } = require('../platform/industry');
const workspaceRepository = require('../db/repositories/workspaceRepository');

function enabledModules(org, industry) {
  const policy = effectivePolicy(org, []);
  const configured = policy.industryModules;
  const available = getIndustryDefinition(industry).modules;
  if (!configured) return available;
  const keys = new Set(configured[industry] || []);
  return available.filter(module => keys.has(module.key));
}

function requireModule(moduleKey) {
  return async (req, res, next) => {
    try {
      const workspace = await workspaceRepository.getActive(req.orgId, req.workspaceId);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
      const org = req.organization || await require('../db/repository').getOrg(req.orgId);
      if (!enabledModules(org, workspace.industry).some(module => module.key === moduleKey)) {
        return res.status(403).json({ error: 'This industry module is not included in the subscription.' });
      }
      next();
    } catch (error) { next(error); }
  };
}

async function requireRecordsModule(req, res, next) {
  try {
    const workspace = await workspaceRepository.getActive(req.orgId, req.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const org = req.organization || await require('../db/repository').getOrg(req.orgId);
    const moduleKey = `${workspace.industry}_records`;
    if (!enabledModules(org, workspace.industry).some(module => module.key === moduleKey)) {
      return res.status(403).json({ error: 'This industry module is not included in the subscription.' });
    }
    next();
  } catch (error) { next(error); }
}

module.exports = { enabledModules, requireModule, requireRecordsModule };
