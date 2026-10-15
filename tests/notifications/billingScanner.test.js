'use strict';
jest.mock('../../src/db/pool', () => ({ getPool: jest.fn() }));
jest.mock('../../src/notifications/service', () => ({ publishQuietly: jest.fn() }));
const { scanProductNotifications, options } = require('../../src/notifications/billingScanner');

describe('billing notification candidate scan', () => {
  const now = '2026-10-15T12:00:00.000Z';
  const period = (id, source, orgId = 'org1') => ({
    id, org_id: orgId, ends_at: '2026-10-17T12:00:00.000Z',
    terms_snapshot_json: JSON.stringify({source}),
  });
  it('publishes real trial and subscription expiry events to scoped audiences', async () => {
    const pool = {query:jest.fn()
      .mockResolvedValueOnce({rows:[period('trial1','free_trial'),period('paid1','purchased')]})
      .mockResolvedValueOnce({rows:[]})};
    const publish = jest.fn().mockResolvedValue({created:true});
    const res = await scanProductNotifications({now}, {pool,publish});
    expect(res).toMatchObject({periodCandidates:2,lowCreditCandidates:0,attempted:4});
    expect(publish.mock.calls.map(([x]) => x.eventKey)).toEqual([
      'billing.trial_expiring','billing.trial_expiring',
      'billing.subscription_expiring','billing.subscription_expiring']);
    expect(publish.mock.calls[0][0]).toMatchObject({orgId:'org1',audience:'organization',dedupeKey:'period:trial1:expiring:7d'});
    expect(pool.query.mock.calls[0][0]).toContain("p.status='active'");
    expect(pool.query.mock.calls[0][0]).toContain('NOT EXISTS');
  });
  it('uses real available INR ledger positions and weekly deduplication', async () => {
    const pool = {query:jest.fn()
      .mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[{org_id:'org2',available_units:'2500'}]})};
    const publish=jest.fn().mockResolvedValue({created:true});
    await scanProductNotifications({now,lowCreditThresholdInr:100},{pool,publish});
    expect(pool.query.mock.calls[1][0]).toContain('SUM(p.balance_units-p.reserved_units)');
    expect(pool.query.mock.calls[1][0]).toContain("g.status='active'");
    expect(pool.query.mock.calls[1][1]).toEqual([now,10000,100]);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0][0]).toMatchObject({eventKey:'billing.credits_low',orgId:'org2',title:'Low credit balance'});
    expect(publish.mock.calls[0][0].message).toContain('₹25.00');
    expect(publish.mock.calls[0][0].dedupeKey).toMatch(/^credit-low:org2:/);
  });
  it('does not guess trial status on corrupt data and never publishes nonexistent low balances', async () => {
    const pool={query:jest.fn().mockResolvedValueOnce({rows:[{
      id:'corrupt',org_id:'org1',ends_at:now,terms_snapshot_json:'{bad',
    }]}).mockResolvedValueOnce({rows:[]})};
    const publish=jest.fn();
    await scanProductNotifications({now},{pool,publish});
    expect(publish).not.toHaveBeenCalled();
  });
  it('rejects unbounded or invalid scan parameters', () => {
    expect(() => options({limit:20000})).toThrow();
    expect(() => options({now:'invalid'})).toThrow();
    expect(() => options({lowCreditThresholdInr:-1})).toThrow();
  });
});
