// Central schedule registry. Business logic does not own timers.
//
// Schedules are intentionally split by responsibility:
// - schedules: VM-local operational schedules such as auto-dial.
// - callbackSchedules: durable callback/retry dispatch. This gets its own
//   container today and can be replaced by EventBridge Scheduler tomorrow.
const schedules = [
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
