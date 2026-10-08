const policy=require('../src/workspaces/organizationPolicy');
const pricing={baseMonthlyInr:1000,includedWorkspaces:1,extraWorkspaceMonthlyInr:200,additionalIndustryMonthlyInr:500};
const single={mode:'single',primaryIndustry:'lending',pricing};
const first=[{id:'default',industry:'lending'}];

test('one invoice charges additional industry packs once across branches',()=>{
  expect(policy.quote({...single,mode:'mixed_industry'},[...first,{industry:'automotive'},{industry:'automotive'}])).toMatchObject({workspaceCount:3,additionalIndustries:1,totalMonthlyInr:1900});
});
test('single-workspace organization upgrades only after accepting the current quote',()=>{
  expect(()=>policy.authorizeCreation(single,first,{industry:'lending'})).toThrow(/pricing changed/);
  const offer=policy.branchQuote(single,first);
  expect(policy.authorizeCreation(single,first,{industry:'lending',pricingAcceptanceToken:offer.token}).mode).toBe('same_industry');
});
test('a concurrent branch or price change invalidates the accepted quote',()=>{
  const token=policy.branchQuote(single,first).token;
  expect(()=>policy.authorizeCreation(single,[...first,{id:'new',industry:'lending'}],{industry:'lending',pricingAcceptanceToken:token})).toThrow(/pricing changed/);
  expect(()=>policy.authorizeCreation({...single,pricing:{...pricing,extraWorkspaceMonthlyInr:300}},first,{industry:'lending',pricingAcceptanceToken:token})).toThrow(/pricing changed/);
});
test('organization admins cannot create another industry even in mixed mode',()=>{
  expect(()=>policy.authorizeCreation({...single,mode:'mixed_industry'},first,{industry:'automotive',pricingAcceptanceToken:policy.branchQuote(single,first).token})).toThrow(/Only platform/);
});
test('platform admins need mixed mode to add a different industry',()=>{
  expect(()=>policy.authorizeCreation(single,first,{industry:'automotive',platformAdmin:true})).toThrow(/mixed-industry/);
  expect(policy.authorizeCreation({...single,mode:'mixed_industry'},first,{industry:'automotive',platformAdmin:true}).mode).toBe('mixed_industry');
});
test('legacy organizations retain their structure with unconfigured prices',()=>{
  expect(policy.effectivePolicy({industry:'lending'},first)).toEqual({...single,pricing:null});
  expect(policy.effectivePolicy({industry:'lending'},[...first,{industry:'automotive'}]).mode).toBe('mixed_industry');
  expect(policy.quote({...single,pricing:null},first)).toBeNull();
  expect(()=>policy.authorizeCreation({...single,pricing:null},first,{industry:'lending'})).toThrow(/configure branch pricing/);
});
test('prices reject negative, invalid and missing amounts while allowing explicit zero',()=>{
  expect(()=>policy.validatePolicy({...single,pricing:{...pricing,baseMonthlyInr:-1}},'lending',['lending'])).toThrow();
  expect(()=>policy.validatePolicy({...single,pricing:{...pricing,extraWorkspaceMonthlyInr:null}},'lending',['lending'])).toThrow();
  expect(policy.validatePolicy({...single,pricing:{...pricing,baseMonthlyInr:0}},'lending',['lending']).pricing.baseMonthlyInr).toBe(0);
});
test('workspace and legacy profile APIs cannot change an existing industry',()=>{
  expect(()=>policy.validateIndustryChange('lending','automotive')).toThrow(/industry is fixed/);
  expect(()=>policy.validateIndustryChange('lending','lending')).not.toThrow();
});
