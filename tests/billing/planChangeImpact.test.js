'use strict';
const { assessPlanTransition } = require('../../src/billing/planChangeImpact');

const amount = units => ({ asset: 'INR', scale: 2, units: String(units) });
function terms(price, overrides = {}) {
  return {
    subscriptionPrice: amount(price),
    structure: { mode: 'mixed_industry', maxWorkspaces: 10, maxDistinctIndustries: 5 },
    seats: { max: 20 },
    industryModules: { lending: ['lending_records', 'loan_lifecycle'] },
    ...overrides,
  };
}
const inventory = { workspaceCount: 2, seatCount: 5, industries: [{ code: 'lending' }] };

describe('subscription change impact', () => {
  test('upgrade with equal entitlements is safe', () => {
    expect(assessPlanTransition(terms(1000), terms(3000), inventory)).toEqual({
      removedModules: [], conflicts: [], isDowngrade: false,
    });
  });
  test('downgrade lists lost modules and does not delete data', () => {
    const target = terms(500, { industryModules: { lending: ['lending_records'] } });
    expect(assessPlanTransition(terms(3000), target, inventory)).toEqual({
      removedModules: [{ industry: 'lending', key: 'loan_lifecycle' }],
      conflicts: [], isDowngrade: true,
    });
  });
  test('blocks plans that cannot fit existing workspaces and seats', () => {
    const target = terms(500, { structure: { mode: 'single', maxWorkspaces: 1, maxDistinctIndustries: 1 }, seats: { max: 2 } });
    const result = assessPlanTransition(terms(3000), target, inventory);
    expect(result.conflicts).toHaveLength(2);
  });
  test('fails closed when inventory cannot be verified', () => {
    expect(assessPlanTransition(terms(1000), terms(500), {} ).conflicts).toHaveLength(1);
  });
});
