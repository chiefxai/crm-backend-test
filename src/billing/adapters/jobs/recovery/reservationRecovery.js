'use strict';

function createReservationRecoveryJob({ repository, reconcileProvider, settleProvider, usageLifecycle, clock, logger = { error() {} }, limit = 100 } = {}) {
  if (typeof repository?.listExpiredOpen !== 'function') throw new TypeError('Reservation recovery job requires repository.listExpiredOpen().');
  if (typeof reconcileProvider !== 'function') throw new TypeError('Reservation recovery requires provider reconciliation before release.');
  if (typeof settleProvider !== 'function') throw new TypeError('Reservation recovery requires a provider settlement callback for billable work.');
  if (typeof usageLifecycle?.release !== 'function') throw new TypeError('Reservation recovery requires the provider usage lifecycle.');
  if (typeof clock?.now !== 'function') throw new TypeError('Reservation recovery requires a clock.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError('limit must be between 1 and 500.');

  return Object.freeze({
    async runOnce() {
      const candidates = await repository.listExpiredOpen({ now: clock.now(), limit });
      const results = [];
      for (const reservation of candidates) {
        try {
          const state = await reconcileProvider(reservation);
          if (state?.status === 'no_billable_work') {
            const released = await usageLifecycle.release({ orgId: reservation.orgId, workspaceId: reservation.workspaceId,
              reservationId: reservation.id, reservationVersion: reservation.version, providerState: 'no_billable_work' });
            results.push({ reservationId: reservation.id, status: 'released', released });
          } else if (state?.status === 'billable_work') {
            // The provider callback persists a rated event before settlement.
            // Recovery never guesses cost or releases funding for billable work.
            const settled = await settleProvider(reservation, state);
            results.push({ reservationId: reservation.id, status: 'settled', settled: settled || null });
          } else {
            results.push({ reservationId: reservation.id, status: 'retained_unknown' });
          }
        } catch (error) {
          logger.error('Reservation recovery failed', { reservationId: reservation.id, orgId: reservation.orgId, code: error.code || 'RECOVERY_FAILED' });
          results.push({ reservationId: reservation.id, status: 'retry', code: error.code || 'RECOVERY_FAILED' });
        }
      }
      return Object.freeze({ scanned: candidates.length, released: results.filter((result) => result.status === 'released').length,
        settled: results.filter((result) => result.status === 'settled').length,
        retainedUnknown: results.filter((result) => result.status === 'retained_unknown').length,
        retry: results.filter((result) => result.status === 'retry').length, results: Object.freeze(results) });
    },
  });
}

module.exports = { createReservationRecoveryJob };
