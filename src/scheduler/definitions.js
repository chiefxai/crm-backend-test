// Central schedule registry. Business logic does not own timers.
//
// Schedules are intentionally split by responsibility:
// - schedules: VM-local operational schedules such as auto-dial.
// - callbackSchedules: durable callback/retry dispatch. This gets its own
//   container today and can be replaced by EventBridge Scheduler tomorrow.
const schedules = [
  {
    id: "billing-notification-outbox",
    expression: process.env.BILLING_NOTIFICATION_OUTBOX_SCHEDULE || "* * * * *",
    run: async () => {
      await require('../billing/notificationOutboxComposition').runBillingNotificationOutboxOnce();
    },
  },
  {
    id: "billing-subscription-period-activation",
    expression: process.env.BILLING_SUBSCRIPTION_ACTIVATION_SCHEDULE || "*/5 * * * *",
    run: async () => {
      await require('../billing/lifecycleJobComposition').runBillingLifecycleOnce({ mode: 'activate' });
    },
  },
  {
    id: "billing-subscription-renewal-reminders",
    expression: process.env.BILLING_RENEWAL_REMINDERS_SCHEDULE || "0 * * * *",
    run: async () => {
      await require('../billing/lifecycleJobComposition').runBillingLifecycleOnce({ mode: 'renewal-reminders' });
    },
  },
  {
    id: "billing-subscription-access-enforcement",
    expression: process.env.BILLING_SUBSCRIPTION_ACCESS_SCHEDULE || "*/5 * * * *",
    run: async () => {
      await require('../billing/lifecycleJobComposition').runBillingLifecycleOnce({ mode: 'enforce-access' });
    },
  },
  {
    id: "workspace-addon-renewals",
    expression: "*/5 * * * *",
    run: async () => {
      await require('../billing/workspaceAddonBilling').createWorkspaceAddonBilling().runMaintenance();
    },
  },
  {
    id: "crm-auto-dial",
    expression: process.env.AUTO_DIAL_SCHEDULE || "*/15 * * * * *",
    run: async () => {
      const { processAutoDialTasks } = require("../crm/autoDialEngine");
      await processAutoDialTasks();
    },
  },
];

const callbackSchedules = [
  {
    id: "crm-dialer-retry",
    expression: process.env.CALLBACK_SCHEDULER_SCHEDULE || process.env.DIALER_RETRY_SCHEDULE || "* * * * *",
    run: async () => {
      const { processDueRetries } = require("../crm/dialerRetryEngine");
      await processDueRetries();
    },
  },
];

module.exports = { schedules, callbackSchedules };
