jest.mock('../src/db/client', () => ({ ready: Promise.resolve() }));
jest.mock('../src/db/pool', () => ({ pool: { query: jest.fn() } }));

const { pool } = require('../src/db/pool');
const workspaceRepository = require('../src/db/repositories/workspaceRepository');

describe('workspace authorization schema', () => {
  test('reads the persisted member feature override column', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ workspace_feature_flags: '["leads"]' }] });

    const result = await workspaceRepository.getAuthorizationState('org-a', 'workspace-a', 'member-a');

    expect(pool.query.mock.calls[0][0]).toContain('wm.feature_flags_json AS workspace_feature_flags');
    expect(result.workspace_feature_flags).toBe('["leads"]');
  });
});
