const policy = require('../src/workspaces/organizationPolicy');

const pricing = {
  baseMonthlyInr:1000, includedWorkspaces:2, maxWorkspaces:4,
  extraWorkspaceMonthlyInr:200, extraSeatMonthlyInr:0,
  includedSeats:1, maxSeats:null, additionalIndustryMonthlyInr:500,
};
const single = {mode:'single',primaryIndustry:'lending',pricing};
const sameIndustry = {mode:'same_industry',primaryIndustry:'lending',pricing};
const first = [{id:'default',industry:'lending'}];

test('monthly quote charges extra workspaces and each extra industry only once', () => {
  const result=policy.quote({...sameIndustry,mode:'mixed_industry'},
    [...first,{id:'one',industry:'automotive'},{id:'two',industry:'automotive'}]);
  expect(result).toMatchObject({workspaceCount:3,additionalWorkspaces:1,additionalIndustries:1,totalMonthlyInr:1700});
});
test('a configured multi-workspace organization must accept the current quote',()=>{
  const offer=policy.branchQuote(sameIndustry,first);
  expect(offer.paymentRequired).toBe(false);
  expect(()=>policy.authorizeCreation(sameIndustry,first,{industry:'lending'})).toThrow(/pricing changed/);
  expect(policy.authorizeCreation(sameIndustry,first,{
    industry:'lending',pricingAcceptanceToken:offer.token,
  }).mode).toBe('same_industry');
});
test('an additional paid workspace requires approved add-on purchase',()=>{
  const two=[...first,{id:'second',industry:'lending'}];
  const offer=policy.branchQuote(sameIndustry,two);
  expect(offer.paymentRequired).toBe(true);
  expect(()=>policy.authorizeCreation(sameIndustry,two,{
    industry:'lending',pricingAcceptanceToken:offer.token,
  })).toThrow(/payment approved/);
  expect(policy.authorizeCreation(sameIndustry,two,{
    industry:'lending',pricingAcceptanceToken:offer.token,paidAddon:true,
  }).mode).toBe('same_industry');
});
test('concurrent branch or price changes invalidate accepted price quote',()=>{
  const token=policy.branchQuote(sameIndustry,first).token;
  expect(()=>policy.authorizeCreation(sameIndustry,[...first,{id:'second',industry:'lending'}],{
    industry:'lending',pricingAcceptanceToken:token,paidAddon:true,
  })).toThrow(/pricing changed/);
  expect(()=>policy.authorizeCreation({...sameIndustry,pricing:{...pricing,extraWorkspaceMonthlyInr:300}},first,{
    industry:'lending',pricingAcceptanceToken:token,
  })).toThrow(/pricing changed/);
});
test('organization admins can create a different industry in mixed mode using its selected quote',()=>{
  const mixed={...sameIndustry,mode:'mixed_industry'};
  const alternateOffer=policy.branchQuote(mixed,first,1,'automotive');
  expect(alternateOffer.paymentRequired).toBe(true);
  expect(alternateOffer.monthlyAddonInr).toBe(pricing.additionalIndustryMonthlyInr);
  expect(()=>policy.authorizeCreation(mixed,first,{
    industry:'automotive',pricingAcceptanceToken:policy.branchQuote(mixed,first).token,
  })).toThrow(/pricing changed/);
  expect(policy.authorizeCreation(mixed,first,{
    industry:'automotive',pricingAcceptanceToken:alternateOffer.token,
  }).mode).toBe('mixed_industry');
  expect(()=>policy.authorizeCreation(sameIndustry,first,{
    industry:'automotive',pricingAcceptanceToken:alternateOffer.token,
  })).toThrow(/primary industry/);
});
test('platform admins need mixed mode to add a different industry',()=>{
  expect(()=>policy.authorizeCreation(sameIndustry,first,{industry:'automotive',platformAdmin:true})).toThrow(/mixed-industry/);
  expect(policy.authorizeCreation({...sameIndustry,mode:'mixed_industry'},first,{
    industry:'automotive',platformAdmin:true,
  }).mode).toBe('mixed_industry');
});
test('single-workspace organizations remain single-workspace even for a platform admin',()=>{
  const plan={...single,pricing:{...pricing,maxWorkspaces:1}};
  expect(()=>policy.authorizeCreation(plan,first,{industry:'lending',platformAdmin:true})).toThrow(/up to/);
});
test('legacy organizations retain structure even with unconfigured prices',()=>{
  expect(policy.effectivePolicy({industry:'lending'},first)).toMatchObject({...single,pricing:null});
  expect(policy.effectivePolicy({industry:'lending'},[...first,{industry:'automotive'}]).mode).toBe('mixed_industry');
  expect(policy.quote({...single,pricing:null},first)).toBeNull();
  expect(()=>policy.authorizeCreation({...single,pricing:null},first,{industry:'lending'})).toThrow(/Upgrade the subscription/);
});
test('prices reject negatives, invalid values, and missing prices while allowing zero',()=>{
  expect(()=>policy.validatePolicy({...single,pricing:{...pricing,baseMonthlyInr:-1}},'lending',['lending'])).toThrow();
  expect(()=>policy.validatePolicy({...single,pricing:{...pricing,extraWorkspaceMonthlyInr:null}},'lending',['lending'])).toThrow();
  expect(policy.validatePolicy({...single,pricing:{...pricing,baseMonthlyInr:0}},'lending',['lending']).pricing.baseMonthlyInr).toBe(0);
});
test('workspace and legacy profile APIs cannot change existing industry',()=>{
  expect(()=>policy.validateIndustryChange('lending','automotive')).toThrow(/industry is fixed/);
  expect(()=>policy.validateIndustryChange('lending','lending')).not.toThrow();
});
test('Enterprise plan creation saves monthly included credits with exact cents',()=>{
  const config={...sameIndustry,planId:'enterprise',planVersion:7,
    pricing:{...pricing,monthlySubscriptionCreditsInr:2500.25}};
  const result=policy.validatePolicy(config,'lending',['lending']);
  expect(result.planId).toBe('enterprise');
  expect(result.planVersion).toBe(7);
  expect(result.pricing.monthlySubscriptionCreditsInr).toBe(2500.25);
  expect(policy.effectivePolicy({settings:{workspacePolicy:result}},first)
    .pricing.monthlySubscriptionCreditsInr).toBe(2500.25);
});
test('missing historical monthly allowance defaults to zero at new creation',()=>{
  expect(policy.validatePolicy(single,'lending',['lending']).pricing.monthlySubscriptionCreditsInr).toBe(0);
});
test.each([-1,NaN,Infinity,25.001,'2500'])('rejects invalid credit amount %s',value=>{
  expect(()=>policy.validatePolicy({...sameIndustry,pricing:{...pricing,monthlySubscriptionCreditsInr:value}},
    'lending',['lending'])).toThrow(/Monthly subscription credits/);
});
