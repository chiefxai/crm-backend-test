'use strict';

const crypto = require('crypto');
const amountMath = require('../../kernel/amount');
const { validateId } = require('../../kernel/scope');

const QUOTE_SCHEMA_VERSION = 1;
const PURPOSES = new Set(['purchase', 'renewal', 'adjustment']);
const MAX_LINES = 128;

function invalid(message, code = 'INVALID_QUOTE') {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be an object.`);
  return value;
}

function safeCount(value, name, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) invalid(`${name} must be a safe integer greater than or equal to ${min}.`);
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function cloneJson(value, name) {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) invalid(`${name} must be JSON serializable.`);
    return JSON.parse(json);
  } catch (error) {
    if (error && error.code === 'INVALID_QUOTE') throw error;
    invalid(`${name} must be JSON serializable.`);
  }
}

function amount(value, name, { nonNegative = true } = {}) {
  try {
    const result = amountMath.validateAmount(value);
    if (nonNegative && BigInt(result.units) < 0n) invalid(`${name} must not be negative.`);
    return result;
  } catch (error) {
    if (error && error.code === 'INVALID_QUOTE') throw error;
    invalid(`${name} must be a valid billing amount.`, error.code || 'INVALID_AMOUNT');
  }
}

function sameCurrency(left, right, name) {
  if (left.asset !== right.asset || left.scale !== right.scale) invalid(`${name} must use ${left.asset} at scale ${left.scale}.`, 'MIXED_CURRENCY');
  return right;
}

function multiply(value, quantity) {
  return amountMath.createAmount(value.asset, BigInt(value.units) * BigInt(quantity), value.scale);
}

function ratioRounded(value, numerator, denominator) {
  const n = BigInt(value.units) * BigInt(numerator);
  const d = BigInt(denominator);
  // Explicit half-up rounding at the smallest currency unit.
  const q = n / d;
  const r = n % d;
  const rounded = (r < 0n ? -r : r) * 2n >= d ? q + (n < 0n ? -1n : 1n) : q;
  return amountMath.createAmount(value.asset, rounded, value.scale);
}

function add(left, right) { return amountMath.add(left, right); }
function subtract(left, right) { return amountMath.subtract(left, right); }
function zeroLike(value) { return amountMath.createAmount(value.asset, '0', value.scale); }

function normalizeInventory(inventory) {
  record(inventory, 'inventory');
  const organizationCount = inventory.organizationCount === undefined ? 1 : safeCount(inventory.organizationCount, 'inventory.organizationCount', { min: 1 });
  if (organizationCount !== 1) invalid('inventory.organizationCount must be 1 for an organization quote.');
  const workspaceCount = safeCount(inventory.workspaceCount, 'inventory.workspaceCount', { min: 1 });
  const seatCount = safeCount(inventory.seatCount === undefined ? 1 : inventory.seatCount, 'inventory.seatCount', { min: 0 });
  let industryCounts = null;
  let industryCodes;
  if (Array.isArray(inventory.industries)) {
    industryCounts = inventory.industries.map((entry, index) => {
      record(entry, `inventory.industries[${index}]`);
      if (typeof entry.code !== 'string' || !entry.code.trim()) invalid(`inventory.industries[${index}].code must be a non-empty string.`);
      return { code: entry.code.trim(), count: safeCount(entry.count, `inventory.industries[${index}].count`, { min: 1 }) };
    }).sort((a, b) => a.code.localeCompare(b.code));
    if (new Set(industryCounts.map((item) => item.code)).size !== industryCounts.length) invalid('inventory.industries must contain distinct industry codes.');
    const totalIndustryWorkspaces = industryCounts.reduce((sum, item) => sum + item.count, 0);
    if (!Number.isSafeInteger(totalIndustryWorkspaces) || totalIndustryWorkspaces !== workspaceCount) {
      invalid('industry counts must sum to inventory.workspaceCount.');
    }
    industryCodes = industryCounts.map((item) => item.code);
  } else {
    industryCodes = inventory.industryCodes;
    if (!Array.isArray(industryCodes) || industryCodes.some((code) => typeof code !== 'string' || !code.trim())) {
      invalid('inventory.industries or inventory.industryCodes must be provided.');
    }
    industryCodes = industryCodes.map((code) => code.trim()).sort();
    if (new Set(industryCodes).size !== industryCodes.length) invalid('inventory.industryCodes must contain distinct codes.');
    if (inventory.industryCounts !== undefined) {
      if (!Array.isArray(inventory.industryCounts)) invalid('inventory.industryCounts must be an array.');
      industryCounts = inventory.industryCounts.map((entry, index) => {
        record(entry, `inventory.industryCounts[${index}]`);
        if (typeof entry.code !== 'string' || !industryCodes.includes(entry.code)) invalid(`inventory.industryCounts[${index}].code must be an inventory industry.`);
        return { code: entry.code, count: safeCount(entry.count, `inventory.industryCounts[${index}].count`, { min: 1 }) };
      }).sort((a, b) => a.code.localeCompare(b.code));
      const totalIndustryWorkspaces = industryCounts.reduce((sum, item) => sum + item.count, 0);
      if (new Set(industryCounts.map((item) => item.code)).size !== industryCodes.length || industryCounts.length !== industryCodes.length || totalIndustryWorkspaces !== workspaceCount) invalid('industryCounts must cover all industries and sum to inventory.workspaceCount.');
    }
  }
  const distinctIndustryCount = safeCount(inventory.distinctIndustryCount === undefined ? industryCodes.length : inventory.distinctIndustryCount, 'inventory.distinctIndustryCount', { min: 1 });
  if (distinctIndustryCount !== industryCodes.length) invalid('distinctIndustryCount must match the supplied industry codes.');
  const version = inventory.version === undefined ? (inventory.sourceVersion === undefined ? null : inventory.sourceVersion) : safeCount(inventory.version, 'inventory.version');
  if (version !== null && typeof version !== 'number' && (typeof version !== 'string' || !version.trim())) invalid('inventory.version/sourceVersion must be a non-empty stable value.');
  return { organizationCount, workspaceCount, seatCount, distinctIndustryCount, industryCodes, industryCounts, version };
}

function normalizeTerms(value) {
  const terms = record(value, 'plan.terms');
  if (terms.schemaVersion !== 1) invalid('plan terms.schemaVersion must be 1.');
  if (typeof terms.currency !== 'string' || !/^[A-Z]{3}$/.test(terms.currency)) invalid('plan terms.currency must be a 3-letter uppercase currency code.');
  const base = amount(terms.subscriptionPrice, 'plan.terms.subscriptionPrice');
  if (base.asset !== terms.currency) invalid('subscriptionPrice must match plan currency.');
  const structure = record(terms.structure, 'plan.terms.structure');
  if (!['single', 'same_industry', 'mixed_industry'].includes(structure.mode)) invalid('plan structure.mode is unsupported.');
  const includedWorkspaces = safeCount(structure.includedWorkspaces === undefined ? 1 : structure.includedWorkspaces, 'plan.terms.structure.includedWorkspaces', { min: 1 });
  const includedDistinctIndustries = safeCount(structure.includedDistinctIndustries === undefined ? 1 : structure.includedDistinctIndustries, 'plan.terms.structure.includedDistinctIndustries', { min: 1 });
  const workspaceFees = record(terms.workspaceFees, 'plan.terms.workspaceFees');
  const workspaceFee = sameCurrency(base, amount(workspaceFees.additionalWorkspace, 'plan.terms.workspaceFees.additionalWorkspace'), 'additionalWorkspace');
  const industryFee = sameCurrency(base, amount(workspaceFees.additionalDistinctIndustry, 'plan.terms.workspaceFees.additionalDistinctIndustry'), 'additionalDistinctIndustry');
  const rawSeats = terms.seats || { included: 1, max: null, additionalSeat: zeroLike(base) };
  const includedSeats = safeCount(rawSeats.included, 'plan.terms.seats.included', { min: 1 });
  const maxSeats = rawSeats.max == null ? null : safeCount(rawSeats.max, 'plan.terms.seats.max', { min: includedSeats });
  const seatFee = sameCurrency(base, amount(rawSeats.additionalSeat, 'plan.terms.seats.additionalSeat'), 'additionalSeat');
  const includedCredits = amount(terms.includedCredits, 'plan.terms.includedCredits');
  const interval = record(terms.billingInterval, 'plan.terms.billingInterval');
  if (!['day', 'week', 'month', 'year'].includes(interval.unit)) invalid('billingInterval.unit is unsupported.');
  safeCount(interval.count, 'billingInterval.count', { min: 1, max: 120 });
  if (!Array.isArray(terms.taxes)) invalid('plan.terms.taxes must be an array.');
  const taxes = terms.taxes.map((tax, index) => {
    record(tax, `plan.terms.taxes[${index}]`);
    if (typeof tax.code !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(tax.code)) invalid(`taxes[${index}].code is invalid.`);
    const rateBps = safeCount(tax.rateBps, `taxes[${index}].rateBps`);
    if (rateBps > 100000) invalid(`taxes[${index}].rateBps must not exceed 100000.`);
    if (!Array.isArray(tax.appliesTo) || tax.appliesTo.length < 1 || tax.appliesTo.some((item) => !['subscription', 'additional_workspace', 'additional_industry', 'additional_seat'].includes(item))) {
      invalid(`taxes[${index}].appliesTo is invalid.`);
    }
    if (typeof tax.inclusive !== 'boolean') invalid(`taxes[${index}].inclusive must be a boolean.`);
    return { code: tax.code, rateBps, appliesTo: [...new Set(tax.appliesTo)].sort(), inclusive: tax.inclusive };
  });
  if (new Set(taxes.map((tax) => tax.code)).size !== taxes.length) invalid('tax codes must be distinct.');
  for (const key of ['maxWorkspaces', 'maxDistinctIndustries']) {
    if (structure[key] !== null && structure[key] !== undefined) safeCount(structure[key], `plan.terms.structure.${key}`, { min: 1 });
  }
  return { base, workspaceFee, industryFee, seatFee, includedSeats, maxSeats, includedCredits, taxes, structure, includedWorkspaces, includedDistinctIndustries };
}

function addLine(lines, { code, label, quantity, unitAmount, amount: lineAmount, taxable = true, discountable = true }) {
  if (BigInt(lineAmount.units) === 0n) return;
  lines.push({
    lineId: code,
    code,
    label,
    quantity,
    unitAmount,
    amount: lineAmount,
    taxable,
    discountable,
  });
}

/**
 * Builds a deterministic, immutable quote from explicit snapshots. Plan prices,
 * eligible credit allowance, inventory and payable totals remain separate facts.
 * Amounts are exact {asset, units, scale} values; only explicit tax/discount
 * basis-point calculations round, using half-up at the currency's smallest unit.
 */
function createQuote(input) {
  record(input, 'input');
  const quoteId = validateId(input.quoteId, 'quoteId');
  const version = safeCount(input.version, 'version', { min: 1 });
  if (!PURPOSES.has(input.purpose)) invalid('purpose must be purchase, renewal, or adjustment.');
  const orgId = validateId(input.orgId, 'orgId');
  const plan = record(input.plan, 'plan');
  const planId = validateId(plan.id, 'plan.id');
  const planVersion = safeCount(plan.version, 'plan.version', { min: 1 });
  const terms = normalizeTerms(plan.terms);
  const inventory = normalizeInventory(input.inventory);
  const createdAt = validTimestamp(input.createdAt, 'createdAt');
  const validUntil = validTimestamp(input.validUntil, 'validUntil');
  if (Date.parse(validUntil) <= Date.parse(createdAt)) invalid('validUntil must be later than createdAt.');

  const hasResolvedConflicts = input.conflicts !== undefined;
  const conflicts = hasResolvedConflicts ? cloneJson(input.conflicts, 'conflicts') : [];
  if (!Array.isArray(conflicts)) invalid('conflicts must be an array.');
  if (!hasResolvedConflicts && terms.structure.mode === 'single' && (inventory.workspaceCount > 1 || inventory.distinctIndustryCount > 1)) {
    conflicts.push({ code: 'PLAN_STRUCTURE_EXCEEDED', message: 'Single-workspace plan does not cover the current organization structure.' });
  }
  if (!hasResolvedConflicts && terms.structure.mode === 'same_industry' && inventory.distinctIndustryCount > 1) {
    conflicts.push({ code: 'MIXED_INDUSTRY_NOT_ALLOWED', message: 'Plan does not allow multiple industries.' });
  }
  if (!hasResolvedConflicts && terms.structure.maxWorkspaces != null && inventory.workspaceCount > terms.structure.maxWorkspaces) {
    conflicts.push({ code: 'WORKSPACE_LIMIT_EXCEEDED', limit: terms.structure.maxWorkspaces, actual: inventory.workspaceCount });
  }
  if (!hasResolvedConflicts && terms.structure.maxDistinctIndustries != null && inventory.distinctIndustryCount > terms.structure.maxDistinctIndustries) {
    conflicts.push({ code: 'INDUSTRY_LIMIT_EXCEEDED', limit: terms.structure.maxDistinctIndustries, actual: inventory.distinctIndustryCount });
  }
  if (!hasResolvedConflicts && terms.maxSeats !== null && inventory.seatCount > terms.maxSeats) {
    conflicts.push({ code: 'SEAT_LIMIT_EXCEEDED', limit: terms.maxSeats, actual: inventory.seatCount });
  }

  const lines = [];
  const baseQuantity = 1;
  addLine(lines, { code: 'subscription_base', label: 'Base subscription', quantity: baseQuantity, unitAmount: terms.base, amount: terms.base });
  const additionalWorkspaces = Math.max(0, inventory.workspaceCount - terms.includedWorkspaces);
  const workspaceLineAmount = multiply(terms.workspaceFee, additionalWorkspaces);
  addLine(lines, { code: 'additional_workspace', label: 'Additional workspaces', quantity: additionalWorkspaces, unitAmount: terms.workspaceFee, amount: workspaceLineAmount });
  const additionalIndustries = Math.max(0, inventory.distinctIndustryCount - terms.includedDistinctIndustries);
  const industryLineAmount = multiply(terms.industryFee, additionalIndustries);
  addLine(lines, { code: 'additional_industry', label: 'Additional distinct industries', quantity: additionalIndustries, unitAmount: terms.industryFee, amount: industryLineAmount });
  const additionalSeats = Math.max(0, inventory.seatCount - terms.includedSeats);
  addLine(lines, { code: 'additional_seat', label: 'Additional user seats', quantity: additionalSeats, unitAmount: terms.seatFee, amount: multiply(terms.seatFee, additionalSeats) });

  let subtotal = zeroLike(terms.base);
  for (const line of lines) subtotal = add(subtotal, line.amount);
  const grossSubtotal = subtotal;

  if (input.adjustments !== undefined) {
    if (!Array.isArray(input.adjustments)) invalid('adjustments must be an array.');
    if (input.adjustments.length > 16) invalid('adjustments must contain at most 16 entries.');
    for (let index = 0; index < input.adjustments.length; index += 1) {
      const adjustment = record(input.adjustments[index], `adjustments[${index}]`);
      const code = typeof adjustment.code === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(adjustment.code) ? adjustment.code : invalid(`adjustments[${index}].code is invalid.`);
      if (lines.some((line) => line.code === `discount_${code}`)) invalid(`discount code ${code} is duplicated.`);
      const appliesTo = adjustment.appliesTo === undefined
        ? ['subscription', 'additional_workspace', 'additional_industry', 'additional_seat']
        : adjustment.appliesTo;
      if (!Array.isArray(appliesTo) || appliesTo.length < 1 || appliesTo.some((item) => !['subscription', 'additional_workspace', 'additional_industry', 'additional_seat'].includes(item))) {
        invalid(`adjustments[${index}].appliesTo is invalid.`);
      }
      const label = adjustment.label === undefined ? 'Discount' : adjustment.label;
      if (typeof label !== 'string' || !label.trim() || label.length > 128) invalid(`adjustments[${index}].label must contain 1 to 128 characters.`);
      const scopeGross = lines.reduce((sum, line) => {
        const category = line.code === 'subscription_base' ? 'subscription' : line.code === 'additional_workspace' ? 'additional_workspace' : line.code === 'additional_industry' ? 'additional_industry' : line.code === 'additional_seat' ? 'additional_seat' : null;
        return category && appliesTo.includes(category) ? add(sum, line.amount) : sum;
      }, zeroLike(terms.base));
      const discountAmount = adjustment.kind === 'percent'
        ? ratioRounded(scopeGross, safeCount(adjustment.rateBps, `adjustments[${index}].rateBps`, { max: 10000 }), 10000)
        : adjustment.kind === 'fixed' ? amount(adjustment.amount, `adjustments[${index}].amount`) : invalid(`adjustments[${index}].kind must be percent or fixed.`);
      const cap = BigInt(scopeGross.units) < BigInt(subtotal.units) ? scopeGross : subtotal;
      const capped = BigInt(discountAmount.units) > BigInt(cap.units) ? cap : discountAmount;
      if (BigInt(capped.units) > 0n) {
        const discountLine = amountMath.createAmount(terms.base.asset, (-BigInt(capped.units)).toString(), terms.base.scale);
        lines.push({ lineId: `discount_${code}`, code: `discount_${code}`, label: label.trim(), quantity: 1, unitAmount: discountLine, amount: discountLine, taxable: true, discountable: false, appliesTo: [...new Set(appliesTo)].sort() });
        subtotal = subtract(subtotal, capped);
      }
    }
  }

  let totalTax = zeroLike(terms.base);
  for (const tax of terms.taxes) {
    const categories = new Set(tax.appliesTo);
    let taxableBase = zeroLike(terms.base);
    const eligibleGross = {};
    for (const line of lines) {
      const category = line.code === 'subscription_base' ? 'subscription'
        : line.code === 'additional_workspace' ? 'additional_workspace'
          : line.code === 'additional_industry' ? 'additional_industry' : line.code === 'additional_seat' ? 'additional_seat' : null;
      if (category) {
        eligibleGross[category] = add(eligibleGross[category] || zeroLike(terms.base), line.amount);
        if (categories.has(category)) taxableBase = add(taxableBase, line.amount);
      }
    }
    for (const discount of lines.filter((line) => line.code.startsWith('discount_'))) {
      const discountCategories = discount.appliesTo.filter((category) => eligibleGross[category]);
      const discountScopeTotal = discountCategories.reduce((sum, category) => add(sum, eligibleGross[category]), zeroLike(terms.base));
      const taxEligibleTotal = discountCategories.filter((category) => categories.has(category))
        .reduce((sum, category) => add(sum, eligibleGross[category]), zeroLike(terms.base));
      if (BigInt(discountScopeTotal.units) > 0n && BigInt(taxEligibleTotal.units) > 0n) {
        const discountShare = ratioRounded(discount.amount, BigInt(taxEligibleTotal.units), BigInt(discountScopeTotal.units));
        taxableBase = add(taxableBase, discountShare);
      }
    }
    if (BigInt(taxableBase.units) <= 0n || tax.rateBps === 0) continue;
    const taxAmount = tax.inclusive
      ? ratioRounded(taxableBase, tax.rateBps, 10000 + tax.rateBps)
      : ratioRounded(taxableBase, tax.rateBps, 10000);
    const taxLine = { lineId: `tax_${tax.code}`, code: `tax_${tax.code}`, label: `Tax ${tax.code}`, quantity: 1, unitAmount: taxAmount, amount: taxAmount, taxable: false, discountable: false, taxCode: tax.code, rateBps: tax.rateBps, inclusive: tax.inclusive };
    lines.push(taxLine);
    totalTax = add(totalTax, taxAmount);
  }
  if (lines.length > MAX_LINES) invalid(`quote must contain at most ${MAX_LINES} lines.`);

  const discountTotal = lines.reduce((sum, line) => line.code.startsWith('discount_') ? add(sum, amountMath.createAmount(terms.base.asset, (-BigInt(line.amount.units)).toString(), line.amount.scale)) : sum, zeroLike(terms.base));
  let total = subtract(grossSubtotal, discountTotal);
  for (const tax of terms.taxes) {
    if (!tax.inclusive) {
      const line = lines.find((candidate) => candidate.code === `tax_${tax.code}`);
      if (line) total = add(total, line.amount);
    }
  }
  const planSnapshot = { id: planId, version: planVersion, terms: cloneJson(plan.terms, 'plan.terms') };
  const snapshot = {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    quoteId,
    version,
    purpose: input.purpose,
    orgId,
    plan: planSnapshot,
    inventory,
    createdAt,
    validUntil,
    conflicts,
    lines,
    subtotal: grossSubtotal,
    discounts: discountTotal,
    totalTax,
    total,
    includedCredits: terms.includedCredits,
    paymentIsCreditValue: false,
  };
  const fingerprint = `sha256:${crypto.createHash('sha256').update(canonicalJson(snapshot)).digest('hex')}`;
  return deepFreeze({ ...snapshot, fingerprint });
}

/** Creates a top-up quote with payment price and issued credits kept separate. */
function createTopupQuote(input) {
  record(input, 'input');
  const quoteId = validateId(input.quoteId, 'quoteId');
  const orgId = validateId(input.orgId, 'orgId');
  const version = safeCount(input.version, 'version', { min: 1 });
  const createdAt = validTimestamp(input.createdAt, 'createdAt');
  const validUntil = validTimestamp(input.validUntil, 'validUntil');
  if (Date.parse(validUntil) <= Date.parse(createdAt)) invalid('validUntil must be later than createdAt.');
  const paymentAmount = amount(input.paymentAmount, 'paymentAmount');
  const topupCredits = amount(input.topupCredits, 'topupCredits');
  if (BigInt(paymentAmount.units) <= 0n || BigInt(topupCredits.units) <= 0n) invalid('paymentAmount and topupCredits must both be greater than zero.');
  const zero = amountMath.createAmount(paymentAmount.asset, '0', paymentAmount.scale);
  const snapshot = {
    schemaVersion: QUOTE_SCHEMA_VERSION, quoteId, version, purpose: 'topup', orgId,
    createdAt, validUntil, conflicts: [],
    lines: [{ lineId: 'topup_payment', code: 'topup_payment', label: 'Prepaid credit top-up', quantity: 1,
      unitAmount: paymentAmount, amount: paymentAmount, taxable: false, discountable: false }],
    subtotal: paymentAmount, discounts: zero, totalTax: zero, total: paymentAmount,
    topupCredits, paymentIsCreditValue: false,
  };
  const fingerprint = `sha256:${crypto.createHash('sha256').update(canonicalJson(snapshot)).digest('hex')}`;
  return deepFreeze({ ...snapshot, fingerprint });
}

function validTimestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    invalid(`${name} must be a UTC ISO-8601 timestamp.`);
  }
  return value;
}

module.exports = { QUOTE_SCHEMA_VERSION, createQuote, createTopupQuote };
