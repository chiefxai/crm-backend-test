'use strict';

const { createPaymentDecisionService } = require('../../../src/billing/modules/payments/decisions');
const { createPeriodActivationService, stableLifecycleId } = require('../../../src/billing/modules/subscriptions/periodActivationService');

const orgId = 'org-a';
const paymentId = 'payment-a';
const periodId = 'period-paid-a';
const approvalAt = '2026-10-12T00:00:00.000Z';
const trialEnds = '2026-10-15T00:00:00.000Z';
const paidEnds = '2026-11-15T00:00:00.000Z';
const amount = {asset:'INR',units:'50000',scale:2};

function approvalFixture({trialConversion = true, creditFailure = false} = {}) {
  const tx = {metadata:{orgId}};
  const idSource = {newId: kind=>`${kind}-test`};
  const repo = {
    getForUpdate:jest.fn(async()=>({
      id:paymentId,orgId,quoteId:'quote-a',status:'pending_verification',version:1,purpose:'subscription',
      expectedAmount:amount,
      quote:{type:'renewal',status:'accepted',paidAt:null,amount},
    })),
    markQuotePaid:jest.fn(async()=>{}),
    saveDecision:jest.fn(async()=>({status:'approved',requestVersionAfter:2})),
    createFulfillment:jest.fn(async()=>({id:'fulfillment-a'})),
  };
  const creditRepository={
    ensureAccount:jest.fn(async(_tx,call)=>({id:call.accountPurpose==='pool'?'organization-pool':'funding-clearing'})),
    createGrant:jest.fn(async(_tx,call)=>{ if(creditFailure)throw Error('failed credit journal');return call.grant; }),
    applyJournal:jest.fn(async()=>({journalId:'journal-a'})),
  };
  const scheduled={
    id:periodId,orgId,startAt:trialEnds,endAt:paidEnds,trialConversion,
    termsSnapshot:{source:'approved_subscription_quote',terms:{includedCredits:amount}},
  };
  const service=createPaymentDecisionService({
    unitOfWork:{runFinancial:async({callback})=>callback(tx)},repository:repo,creditRepository,
    periodLifecycle:{schedulePaidRenewalInTransaction:jest.fn(async()=>scheduled)},
    subscriptionRepository:{fundPeriodLinkForQuote:jest.fn()},
    invoiceRepository:{},
    outbox:{enqueue:jest.fn(async()=>{})},
    idSource,clock:{now:()=>approvalAt},authorizeDecision:async()=>true,
  });
  const execute=()=>service.decide({
    command:{schemaVersion:1,orgId,paymentRequestId:paymentId,decision:'approve',
      expectedVersion:1,receivedAmount:amount},
    trustedContext:{schemaVersion:1,operationId:'approve-a',
      requestFingerprint:'sha256:'+('a'.repeat(64)),
      actor:{type:'user',id:'admin-a',organizationId:orgId}},
  });
  return {execute,repo,creditRepository,scheduled};
}

describe('credits for a paid subscription purchased during a free trial',()=>{
  test('approved trial payment issues paid credit grant NOW, expiring after paid period',async()=>{
    const {execute,creditRepository}=approvalFixture();
    const result=await execute();
    const grant=creditRepository.createGrant.mock.calls[0][1].grant;
    expect(grant).toMatchObject({
      id:stableLifecycleId('subscription-grant',`${orgId}\0${periodId}`),
      grantKind:'subscription',sourceType:'subscription_period',sourceId:periodId,
      paymentRequestId:paymentId,periodId,effectiveAt:approvalAt,expiresAt:paidEnds,amount,
    });
    expect(result.funding).toMatchObject({status:'scheduled',startsAt:trialEnds,
      paidCreditsAvailableNow:{grantId:grant.id,amount,effectiveAt:approvalAt,expiresAt:paidEnds}});
    expect(creditRepository.applyJournal).toHaveBeenCalledTimes(1);
  });
  test('normal early renewals do not issue credits before their next period',async()=>{
    const {execute,creditRepository}=approvalFixture({trialConversion:false});
    const result=await execute();
    expect(result.funding.paidCreditsAvailableNow).toBeUndefined();
    expect(creditRepository.createGrant).not.toHaveBeenCalled();
  });
  test('credit funding failure aborts the payment decision transaction',async()=>{
    const {execute,creditRepository}=approvalFixture({creditFailure:true});
    await expect(execute()).rejects.toThrow('failed credit journal');
    expect(creditRepository.applyJournal).not.toHaveBeenCalled();
  });

  test('paid-period activation reuses an existing prepaid grant without granting twice',async()=>{
    const tx={metadata:{orgId}};
    const grantId=stableLifecycleId('subscription-grant',`${orgId}\0${periodId}`);
    const creditRepository={
      ensureAccount:jest.fn(async(_tx,opts)=>({id:opts.accountPurpose})),
      createGrant:jest.fn(),applyJournal:jest.fn(),
      getGrantForUpdate:jest.fn(async()=>({
        id:grantId,orgId,grantKind:'subscription',sourceType:'subscription_period',
        sourceId:periodId,periodId,paymentRequestId:paymentId,status:'active',amount,
        effectiveAt:approvalAt,expiresAt:paidEnds,
      })),
    };
    const outbox={enqueue:jest.fn(async()=>{})};
    const service=createPeriodActivationService({
      unitOfWork:{runFinancial:async({callback})=>callback(tx)},
      periodRepository:{
        getPeriod:async()=>({id:periodId,orgId,periodKind:'subscription',status:'scheduled',
          startAt:trialEnds,endAt:paidEnds,termsSnapshot:{terms:{includedCredits:amount}}}),
        getPeriodFunding:async()=>({paymentRequestId:paymentId}),
        listPeriods:async()=>[],
        transitionPeriod:async()=>({id:periodId,status:'active'}),
      },
      creditRepository,
      subscriptionRepository:{activateLinkedPeriod:jest.fn(async()=>{})},
      outbox,clock:{now:()=>trialEnds},
    });
    const result=await service.activatePeriod({orgId,periodId,now:trialEnds});
    expect(result.grant).toMatchObject({grantId,preissued:true,effectiveAt:approvalAt,expiresAt:paidEnds});
    expect(creditRepository.createGrant).not.toHaveBeenCalled();
    expect(creditRepository.applyJournal).not.toHaveBeenCalled();
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
  });

  test('activation refuses a mismatched prepaid grant instead of issuing a replacement',async()=>{
    const tx={metadata:{orgId}};
    const creditRepository={
      ensureAccount:jest.fn(async(_tx,opts)=>({id:opts.accountPurpose})),
      createGrant:jest.fn(),applyJournal:jest.fn(),
      getGrantForUpdate:jest.fn(async()=>({
        id:'wrong',orgId,grantKind:'subscription',sourceType:'subscription_period',
        sourceId:periodId,periodId,paymentRequestId:paymentId,status:'active',
        amount:{...amount,units:'999'},effectiveAt:approvalAt,expiresAt:paidEnds,
      })),
    };
    const service=createPeriodActivationService({
      unitOfWork:{runFinancial:async({callback})=>callback(tx)},
      periodRepository:{
        getPeriod:async()=>({id:periodId,orgId,periodKind:'subscription',status:'scheduled',
          startAt:trialEnds,endAt:paidEnds,termsSnapshot:{terms:{includedCredits:amount}}}),
        getPeriodFunding:async()=>({paymentRequestId:paymentId}),
        listPeriods:async()=>[],
        transitionPeriod:async()=>({id:periodId,status:'active'}),
      },
      creditRepository,outbox:{enqueue:jest.fn()},clock:{now:()=>trialEnds},
    });
    await expect(service.activatePeriod({orgId,periodId,now:trialEnds})).rejects.toMatchObject({
      code:'BILLING_IDEMPOTENCY_CONFLICT',
    });
    expect(creditRepository.createGrant).not.toHaveBeenCalled();
  });
});
