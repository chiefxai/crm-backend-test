'use strict';

const { safeErrorMessage } = require('../src/observability/safeError');

describe('safe error messages', () => {
  test('exposes the last workspace admin conflict instead of disguising it as a server error', () => {
    const error = Object.assign(
      new Error('Assign another active Workspace Admin before removing the last one'),
      { statusCode: 409, expose: true },
    );

    expect(safeErrorMessage(error)).toBe('Assign another active Workspace Admin before removing the last one');
  });

  test('keeps internal errors hidden', () => {
    expect(safeErrorMessage(new Error('sensitive SQL detail'))).toBe('Internal server error');
  });
});
