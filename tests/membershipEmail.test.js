const { matchMembershipsByNormalizedEmail } = require('../src/db/membershipEmail');

describe('legacy membership email matching', () => {
  test.each(['ops_%@example.com', 'ops_1@example.com', 'ops_%x@example.com'])('%s matches only the same normalized address', (email) => {
    const deceptiveMatch = email.replace('_', '1').replace('%', 'a');
    const rows = [
      { id: 'exact', email: ` ${email.toUpperCase()} ` },
      { id: 'pattern-expansion', email: deceptiveMatch },
    ];

    expect(matchMembershipsByNormalizedEmail(rows, email).map((row) => row.id)).toEqual(['exact']);
  });

  test('does not match when no exact normalized address exists', () => {
    expect(matchMembershipsByNormalizedEmail([
      { id: 'near-match', email: 'ops-a@example.com' },
      { id: 'missing-email', email: null },
    ], 'ops_%@example.com')).toEqual([]);
  });
});
