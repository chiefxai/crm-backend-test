'use strict';
const { catalogFor, eventFor } = require('../../src/notifications/catalog');
const { createRepository } = require('../../src/notifications/repository');
const { createService } = require('../../src/notifications/service');

describe('unified notifications', () => {
  test('catalog excludes transport messages and supports both audiences', () => {
    expect(eventFor('connection.connected','organization')).toBeNull();
    expect(catalogFor('platform').some(row => row.key === 'payment.submitted')).toBe(true);
    expect(catalogFor('organization').some(row => row.key === 'campaign.completed')).toBe(true);
    expect(catalogFor('organization').some(row => row.key === 'payment.submitted')).toBe(false);
  });

  test('publish is deduplicated and does not broadcast an event twice', async () => {
    const saved = {id:'abc',created:true};
    const repository = { create:jest.fn().mockResolvedValueOnce(saved).mockResolvedValueOnce({created:false}),
      enqueueEmailRecipients:jest.fn().mockResolvedValue(undefined) };
    const broadcast = jest.fn();
    const flushEmail = jest.fn().mockResolvedValue({processed:0});
    const service = createService({repository,broadcast,flushEmail});
    const event = { audience:'organization',orgId:'org1',eventKey:'campaign.completed',dedupeKey:'campaign:1',
      title:'Completed',message:'Done' };
    await service.publish(event);
    await service.publish(event);
    expect(repository.enqueueEmailRecipients).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  test('feed filtering is tenant-scoped and honors disabled browser preferences', async () => {
    const pool={query:jest.fn().mockResolvedValue({rows:[]})};
    const repo=createRepository(pool);
    await repo.list({audience:'organization',userId:'user1',orgId:'org1',workspaceId:'ws1'});
    const [sql,params]=pool.query.mock.calls[0];
    expect(sql).toContain('n.org_id=?');
    expect(sql).toContain('n.workspace_id=?');
    expect(sql).toContain('p.enabled IS NULL OR p.enabled=1');
    expect(params).toEqual(expect.arrayContaining(['org1','ws1']));
    await repo.list({audience:'platform',userId:'admin'});
    expect(pool.query.mock.calls[1][0]).toContain("n.audience='platform'");
  });

  test('mark read refuses cross-organization ids at SQL boundary', async () => {
    const pool={query:jest.fn().mockResolvedValue({affectedRows:0})};
    const repo=createRepository(pool);
    await repo.markRead({audience:'organization',orgId:'org1',workspaceId:'ws1',userId:'u1',id:'id'});
    expect(pool.query.mock.calls[0][0]).toContain('n.org_id=?');
    expect(pool.query.mock.calls[0][0]).toContain('n.id=?');
    expect(pool.query.mock.calls[0][1]).toEqual(['u1','org1','ws1','id']);
  });

  test('preference update validates catalog, channels and duplicates', async () => {
    const pool={query:jest.fn().mockResolvedValue({rows:[]})};
    const repo=createRepository(pool);
    await expect(repo.setPreferences({audience:'platform',userId:'u1',changes:[
      {eventKey:'campaign.completed',channel:'email',enabled:true},
    ]})).rejects.toThrow('Invalid notification preference');
    await expect(repo.setPreferences({audience:'organization',userId:'u1',changes:[
      {eventKey:'campaign.completed',channel:'browser',enabled:true},
      {eventKey:'campaign.completed',channel:'browser',enabled:false},
    ]})).rejects.toThrow('Duplicate notification preference');
  });
});
