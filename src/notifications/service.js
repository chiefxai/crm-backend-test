'use strict';
const { createRepository } = require('./repository');
const { sendRefreshHint } = require('./channels/browserSse');
const { flush } = require('./channels/smtp');
const { getLogger } = require('../observability/logger');
const log = getLogger('notifications.service');
function createService({ repository = createRepository(), broadcast = sendRefreshHint, flushEmail = flush } = {}) {
  async function publish(input) {
    const saved = await repository.create(input);
    if (!saved.created) return saved;
    try {
      await repository.enqueueEmailRecipients({ ...input, id: saved.id });
    } catch(error) {
      // Never roll back a real business operation due to missing SMTP state.
      log.error('Notification persisted but email enqueue failed',error);
    }
    broadcast(input);
    setImmediate(() => Promise.resolve().then(() => flushEmail()).catch(error=>log.error('SMTP notification flush failed',error)));
    return saved;
  }
  return { publish, ...repository };
}
let configured;
function getService() { if (!configured) configured = createService(); return configured; }
async function publishQuietly(input) {
  try { return await getService().publish(input); }
  catch(error) { log.error('Failed to create product notification',{ eventKey:input.eventKey,orgId:input.orgId,error }); return null; }
}
module.exports = { createService, getService, publishQuietly };