'use strict';
// One extensible catalog for every audience and delivery channel. Technical SSE
// connection/heartbeat/log messages are deliberately absent.
const EVENTS = Object.freeze([
  { key: 'campaign.completed', category: 'Campaigns', label: 'Campaign completed', audiences: ['organization'], browser: true, email: false },
  { key: 'campaign.failed', category: 'Campaigns', label: 'Campaign failed', audiences: ['organization'], browser: true, email: false },
  { key: 'call.completed', category: 'Calls', label: 'Call completed', audiences: ['organization'], browser: true, email: false },
  { key: 'call.missed', category: 'Calls', label: 'Missed call', audiences: ['organization'], browser: true, email: false },
  { key: 'payment.submitted', category: 'Billing', label: 'Payment submitted for review', audiences: ['platform'], browser: true, email: false },
  { key: 'payment.approved', category: 'Billing', label: 'Payment approved', audiences: ['platform','organization'], browser: true, email: false },
  { key: 'payment.rejected', category: 'Billing', label: 'Payment rejected', audiences: ['platform','organization'], browser: true, email: false },
  { key: 'billing.grace_requested', category: 'Billing', label: 'Subscription grace request', audiences: ['platform'], browser: true, email: false },
  { key: 'billing.grace_decided', category: 'Billing', label: 'Subscription grace decision', audiences: ['platform','organization'], browser: true, email: false },
  { key: 'billing.subscription_expiring', category: 'Billing', label: 'Subscription expiring', audiences: ['organization','platform'], browser: true, email: false },
  { key: 'billing.trial_expiring', category: 'Billing', label: 'Trial expiring', audiences: ['organization','platform'], browser: true, email: false },
  { key: 'billing.credits_low', category: 'Billing', label: 'Low credit balance', audiences: ['organization','platform'], browser: true, email: false },
  { key: 'system.announcement', category: 'System', label: 'System announcements', audiences: ['platform','organization'], browser: true, email: false },
]);
const CHANNELS = Object.freeze(['browser', 'email']);
function eventFor(key, audience) {
  return EVENTS.find(event => event.key === key && event.audiences.includes(audience)) || null;
}
function catalogFor(audience) {
  return EVENTS.filter(event => event.audiences.includes(audience)).map(({ key, category, label, browser, email }) => ({
    key, category, label, defaults: { browser, email },
  }));
}
module.exports = { EVENTS, CHANNELS, eventFor, catalogFor };