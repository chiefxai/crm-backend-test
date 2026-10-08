'use strict';

const templates = require('../../../email/templates');
const { decryptPayload } = require('./payloadCodec');

function createEmailDeliveryWorker({ repository, mailer, workerId, clock, batchSize = 25 } = {}) {
  if (typeof repository?.claim !== 'function' || typeof repository?.settle !== 'function') throw new TypeError('Email delivery worker requires claim() and settle().');
  if (typeof mailer?.sendMailResult !== 'function') throw new TypeError('Email delivery worker requires mailer.sendMailResult().');
  if (!workerId || typeof workerId !== 'string' || typeof clock?.now !== 'function') throw new TypeError('Email delivery worker requires a stable worker ID and clock.');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 250) throw new TypeError('Email delivery batchSize must be from 1 to 250.');

  async function runOnce({ limit = batchSize } = {}) {
    const outcomes = [];
    for (let index = 0; index < limit; index += 1) {
      const delivery = await repository.claim({ workerId, now: clock.now() });
      if (!delivery) break;
      let result;
      try {
        if (!delivery.email) throw Object.assign(new Error('Delivery has no recipient email.'), { code: 'EMAIL_RECIPIENT_MISSING' });
        const payload = delivery.payload?.version === 1 ? decryptPayload(delivery.payload) : delivery.payload;
        const data = payload || (delivery.notification ? {
          ...delivery.notification, ...(delivery.notification.payload || {}),
          actionUrl: delivery.notification.payload?.paymentUrl || delivery.notification.actionPath || undefined,
        } : {});
        const message = templates.renderTemplate(delivery.templateKey, data);
        result = await mailer.sendMailResult({ to: delivery.email, ...message });
        if (!result || !['submitted', 'skipped_unconfigured', 'failed'].includes(result.status)) {
          result = { status: 'failed', retryable: true, errorCode: 'SMTP_ADAPTER_INVALID_RESULT' };
        }
      } catch (error) {
        result = { status: 'failed', retryable: Boolean(error?.retryable), errorCode: String(error?.code || 'EMAIL_RENDER_FAILED').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96) };
      }
      const settlement = await repository.settle(delivery, result);
      outcomes.push(Object.freeze({ deliveryId: delivery.id, status: settlement.status, resultStatus: result.status }));
    }
    return Object.freeze({ processed: outcomes.length, outcomes: Object.freeze(outcomes) });
  }

  return Object.freeze({ runOnce });
}

module.exports = { createEmailDeliveryWorker };
