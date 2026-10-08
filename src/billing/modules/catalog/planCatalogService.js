'use strict';

const { normalizePlanTerms, applyPlanOverrides } = require('./terms');

function requiredId(value, path) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(value)) throw new TypeError(`${path} must be a valid identifier.`);
  return value;
}
function timestamp(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${path} must be an ISO-8601 timestamp with an explicit timezone.`);
  }
  return new Date(value).toISOString();
}
function requiredText(value, path, max = 191) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new TypeError(`${path} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}

/**
 * Platform plan catalog application service.
 * @param {{repository: PlanCatalogRepository, idSource:{newId(kind?:string):string}, clock:{now():string}}} deps
 */
function createPlanCatalogService({ repository, idSource, clock }) {
  if (!repository || typeof repository.createPlanWithDraft !== 'function'
    || typeof repository.createDraftVersion !== 'function'
    || typeof repository.replaceDraftTerms !== 'function'
    || typeof repository.publishDraft !== 'function'
    || typeof repository.getVersion !== 'function'
    || typeof repository.getEffectiveVersion !== 'function'
    || typeof repository.listPlans !== 'function'
    || typeof repository.listVersions !== 'function'
    || typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function') {
    throw new TypeError('Plan catalog requires its repository, ID source, and clock ports.');
  }

  async function createPlan({ code, displayName, terms }) {
    const planId = requiredId(idSource.newId('billing-plan'), 'planId');
    const versionId = requiredId(idSource.newId('billing-plan-version'), 'versionId');
    const normalizedTerms = normalizePlanTerms(terms);
    const now = timestamp(clock.now(), 'clock.now()');
    const created = await repository.createPlanWithDraft({
      plan: { id: planId, code: requiredText(code, 'code', 64), displayName: requiredText(displayName, 'displayName'), now },
      version: buildVersionRecord({ id: versionId, planId, version: 1, terms: normalizedTerms, now }),
    });
    return { ...created, version: mapPlanVersion(created.version) };
  }

  async function createDraftVersion({ planId, terms }) {
    planId = requiredId(planId, 'planId');
    const normalizedTerms = normalizePlanTerms(terms);
    const now = timestamp(clock.now(), 'clock.now()');
    const versionId = requiredId(idSource.newId('billing-plan-version'), 'versionId');
    const created = await repository.createDraftVersion({ planId, id: versionId, terms: normalizedTerms, now });
    return created ? mapPlanVersion(created) : null;
  }

  async function updateDraft({ planId, version, terms }) {
    planId = requiredId(planId, 'planId');
    if (!Number.isSafeInteger(version) || version < 1) throw new TypeError('version must be a positive integer.');
    const normalizedTerms = normalizePlanTerms(terms);
    const updated = await repository.replaceDraftTerms({ planId, version, terms: normalizedTerms, now: timestamp(clock.now(), 'clock.now()') });
    return updated ? mapPlanVersion(updated) : null;
  }

  async function publishDraft({ planId, version, effectiveFrom }) {
    planId = requiredId(planId, 'planId');
    if (!Number.isSafeInteger(version) || version < 1) throw new TypeError('version must be a positive integer.');
    const effectiveAt = timestamp(effectiveFrom || clock.now(), 'effectiveFrom');
    const published = await repository.publishDraft({ planId, version, effectiveAt, now: timestamp(clock.now(), 'clock.now()') });
    return published && published.terms ? mapPlanVersion(published) : published;
  }

  async function getVersion({ planId, version }) {
    const record = await repository.getVersion({ planId: requiredId(planId, 'planId'), version });
    return record ? mapPlanVersion(record) : null;
  }

  async function getEffectiveVersion({ planId, at }) {
    const effectiveAt = timestamp(at || clock.now(), 'at');
    const record = await repository.getEffectiveVersion({ planId: requiredId(planId, 'planId'), at: effectiveAt });
    return record ? mapPlanVersion(record) : null;
  }

  async function resolvePurchasedTerms({ planVersion, override }) {
    if (!planVersion || typeof planVersion !== 'object') throw new TypeError('planVersion is required.');
    const version = mapPlanVersion(planVersion);
    return applyPlanOverrides(version.terms, override || {});
  }

  async function listPlans({ status, limit = 100, afterId } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('limit must be an integer from 1 to 500.');
    if (status !== undefined && !['draft', 'active', 'retired'].includes(status)) throw new TypeError('status is unsupported.');
    if (afterId !== undefined) afterId = requiredId(afterId, 'afterId');
    return repository.listPlans({ status, limit, afterId });
  }

  async function listVersions({ planId, limit = 100, afterVersion } = {}) {
    planId = requiredId(planId, 'planId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('limit must be an integer from 1 to 500.');
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 1)) throw new TypeError('afterVersion must be a positive integer.');
    const records = await repository.listVersions({ planId, limit, afterVersion });
    return records.map(mapPlanVersion);
  }

  return Object.freeze({ createPlan, createDraftVersion, updateDraft, publishDraft, getVersion, getEffectiveVersion, listPlans, listVersions, resolvePurchasedTerms });
}

function buildVersionRecord({ id, planId, version, terms, now }) {
  return {
    id, planId, version, status: 'draft', terms,
    priceUnits: terms.subscriptionPrice.units,
    priceAsset: terms.subscriptionPrice.asset,
    priceScale: terms.subscriptionPrice.scale,
    includedCreditUnits: terms.includedCredits.units,
    creditAsset: terms.includedCredits.asset,
    creditScale: terms.includedCredits.scale,
    currency: terms.currency,
    billingIntervalUnit: terms.billingInterval.unit,
    billingIntervalCount: terms.billingInterval.count,
    now,
  };
}

function mapPlanVersion(record) {
  const terms = typeof record.terms === 'string' ? JSON.parse(record.terms) : record.terms;
  return Object.freeze({
    id: record.id,
    planId: record.planId || record.plan_id,
    version: Number(record.version),
    status: record.status,
    effectiveFrom: record.effectiveFrom || record.effective_from || null,
    effectiveTo: record.effectiveTo || record.effective_to || null,
    publishedAt: record.publishedAt || record.published_at || null,
    terms: normalizePlanTerms(terms),
  });
}

/**
 * Repository contract implemented by MySQL and test adapters.
 * @typedef {object} PlanCatalogRepository
 * @property {(args:{plan:object,version:object})=>Promise<object>} createPlanWithDraft
 * @property {(args:{planId:string,id:string,terms:object,now:string})=>Promise<object>} createDraftVersion
 * @property {(args:{planId:string,version:number,terms:object,now:string})=>Promise<object>} replaceDraftTerms
 * @property {(args:{planId:string,version:number,effectiveAt:string,now:string})=>Promise<object>} publishDraft
 * @property {(args:{planId:string,version:number})=>Promise<object|null>} getVersion
 * @property {(args:{planId:string,at:string})=>Promise<object|null>} getEffectiveVersion
 * @property {(args:{status?:string,limit:number,afterId?:string})=>Promise<object[]>} listPlans
 * @property {(args:{planId:string,limit:number,afterVersion?:number})=>Promise<object[]>} listVersions
 */

module.exports = { createPlanCatalogService, mapPlanVersion, buildVersionRecord };
