const mockDb = { patch: jest.fn().mockResolvedValue({}) };
const mockTelephony = {
  getDefaultProvider: jest.fn(() => 'vobiz'),
  triggerOutboundCall: jest.fn().mockResolvedValue({ callSid: 'call-1' }),
};
const mockResolver = { resolveAssignedNumber: jest.fn() };
jest.mock('../../src/db/repository', () => mockDb);
jest.mock('../../src/telephony/registry', () => mockTelephony);
jest.mock('../../src/telephony/connectorCredentialResolver', () => mockResolver);

const { handlePlaceRedialJobScoped } = require('../../src/crm/dialerRetryEngine');

describe('connector retry feature gate', () => {
  const accountFlag = process.env.TELEPHONY_CONNECTOR_ACCOUNTS_ENABLED;
  const routingFlag = process.env.TELEPHONY_CONNECTOR_CALL_ROUTING_ENABLED;
  afterEach(() => {
    if (accountFlag === undefined) delete process.env.TELEPHONY_CONNECTOR_ACCOUNTS_ENABLED;
    else process.env.TELEPHONY_CONNECTOR_ACCOUNTS_ENABLED = accountFlag;
    if (routingFlag === undefined) delete process.env.TELEPHONY_CONNECTOR_CALL_ROUTING_ENABLED;
    else process.env.TELEPHONY_CONNECTOR_CALL_ROUTING_ENABLED = routingFlag;
    jest.clearAllMocks();
  });

  test.each([
    ['accounts', 'false', 'true'],
    ['call routing', 'true', 'false'],
  ])('does not place an already queued connector retry if %s flag is off', async (_name, accountsEnabled, routingEnabled) => {
    process.env.TELEPHONY_CONNECTOR_ACCOUNTS_ENABLED = accountsEnabled;
    process.env.TELEPHONY_CONNECTOR_CALL_ROUTING_ENABLED = routingEnabled;
    await handlePlaceRedialJobScoped({
      orgId: 'org-1', workspaceId: 'workspace-1', rowId: 'log-1', dialTarget: '+14155550123',
      telephonyContext: { phoneNumberId: 'number-1', providerKey: 'vobiz' },
    });
    expect(mockDb.patch).toHaveBeenCalledWith('calllogs', 'org-1', 'log-1', { retryStatus: 'exhausted', retryClaimedAt: null });
    expect(mockResolver.resolveAssignedNumber).not.toHaveBeenCalled();
    expect(mockTelephony.triggerOutboundCall).not.toHaveBeenCalled();
  });
});
