'use strict';

const { assertTransactionContext, createTransactionContext } = require('../../src/billing/kernel/transactionContext');

describe('billing transaction context', () => {
  test('copies and deeply freezes safe metadata without exposing transaction controls', () => {
    const sourceMetadata = {
      orgId: 'org-1',
      operationId: 'cmd-1',
      expectedVersions: { account: 4 },
    };
    const tx = createTransactionContext({ query: async () => ({ rows: [] }), release() {} }, sourceMetadata);

    sourceMetadata.expectedVersions.account = 99;
    expect(tx.metadata).toEqual({ orgId: 'org-1', operationId: 'cmd-1', expectedVersions: { account: 4 } });
    expect(Object.isFrozen(tx.metadata)).toBe(true);
    expect(Object.isFrozen(tx.metadata.expectedVersions)).toBe(true);
    expect(Object.keys(tx).sort()).toEqual(['metadata', 'query']);
    expect(tx.release).toBeUndefined();
    expect(assertTransactionContext(tx)).toBe(tx);
  });
});
