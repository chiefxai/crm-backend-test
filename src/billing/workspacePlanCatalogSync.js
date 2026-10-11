'use strict';

const { workspacePlanCatalogInput } = require('./modules/catalog/workspacePlanMapper');

function error(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

function sameTerms(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Bridges the platform's versioned workspace-plan setting into the canonical
 * financial catalog. The catalog version is the immutable purchase authority;
 * changes in workspace settings create a new published catalog version.
 */
function createWorkspacePlanCatalogSyncService({ getWorkspacePlans, getBillingPolicy, catalogService, clock } = {}) {
  if (typeof getWorkspacePlans !== 'function' || typeof getBillingPolicy !== 'function') {
    throw new TypeError('Workspace plan catalog sync requires workspace-plan and billing-policy readers.');
  }
  for (const method of ['createPlan', 'createDraftVersion', 'publishDraft', 'getVersion', 'getEffectiveVersion', 'listPlans', 'listVersions']) {
    if (typeof catalogService?.[method] !== 'function') throw new TypeError(`Plan catalog service requires ${method}().`);
  }
  if (typeof clock?.now !== 'function') throw new TypeError('Workspace plan catalog sync requires clock.now().');

  async function resolvePlanVersion({ workspacePlanId, workspacePlanVersion, at } = {}) {
    if (typeof workspacePlanId !== 'string' || !workspacePlanId.trim()) throw new TypeError('workspacePlanId is required.');
    const workspacePlans = await getWorkspacePlans();
    if (!Number.isSafeInteger(workspacePlanVersion) || workspacePlanVersion !== workspacePlans.version) {
      throw error('VERSION_CONFLICT', 'Workspace plan settings changed. Reload the subscription quote before continuing.');
    }
    const sourcePlan = workspacePlans.plans.find((candidate) => candidate.id === workspacePlanId && candidate.active);
    if (!sourcePlan) throw error('NOT_FOUND', 'The selected workspace plan is no longer active.', 404);
    const configured = await getBillingPolicy();
    if (!configured?.configured || !configured.policy) {
      throw error('SUBSCRIPTION_TERMS_NOT_CONFIGURED', 'The platform must configure subscription taxes and financial terms before an organization can receive a payable subscription quote.', 409);
    }

    const { code, displayName, terms } = workspacePlanCatalogInput(sourcePlan, configured.policy);
    const effectiveAtValue = at || clock.now();
    const effectiveAt = effectiveAtValue instanceof Date ? effectiveAtValue.toISOString() : new Date(effectiveAtValue).toISOString();
    if (!Number.isFinite(Date.parse(effectiveAt))) throw new TypeError('at must be a valid timestamp.');

    let catalogPlan = (await catalogService.listPlans({ limit: 500 })).find((candidate) => candidate.code === code);
    if (!catalogPlan) {
      try {
        const created = await catalogService.createPlan({ code, displayName, terms });
        const published = await catalogService.publishDraft({ planId: created.plan.id, version: created.version.version, effectiveFrom: effectiveAt });
        if (published?.status === 'published') return published;
      } catch (cause) {
        // A concurrent organization setup may create the same mapped plan.
        // Re-read and continue against the canonical record below.
        catalogPlan = (await catalogService.listPlans({ limit: 500 })).find((candidate) => candidate.code === code);
        if (!catalogPlan) throw cause;
      }
      catalogPlan = (await catalogService.listPlans({ limit: 500 })).find((candidate) => candidate.code === code);
    }
    if (!catalogPlan) throw error('BILLING_CATALOG_STORAGE', 'The workspace plan could not be synchronized to the billing catalog.', 503);

    let current = await catalogService.getEffectiveVersion({ planId: catalogPlan.id, at: effectiveAt });
    if (current && sameTerms(current.terms, terms)) return current;

    const versions = await catalogService.listVersions({ planId: catalogPlan.id, limit: 500 });
    const reusableDraft = versions.find((version) => version.status === 'draft' && sameTerms(version.terms, terms));
    const draft = reusableDraft || await catalogService.createDraftVersion({ planId: catalogPlan.id, terms });
    const published = await catalogService.publishDraft({ planId: catalogPlan.id, version: draft.version, effectiveFrom: effectiveAt });
    if (published?.status === 'published') return published;

    current = await catalogService.getEffectiveVersion({ planId: catalogPlan.id, at: effectiveAt });
    if (current && sameTerms(current.terms, terms)) return current;
    throw error('VERSION_CONFLICT', 'The subscription plan changed while its billing version was being published. Retry the organization setup.');
  }

  return Object.freeze({ resolvePlanVersion });
}

module.exports = { createWorkspacePlanCatalogSyncService };
