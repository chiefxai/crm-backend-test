const { getScope } = require("./workspaces/scope");
// Shared mutable server state — passed between the HTTP layer and WebSocket
// handlers. Kept in one place so route files and WS handlers all reference
// the same instances rather than creating independent copies.

let activeSessionsCount = 0;
let logClients = []; // [{ res, orgId }]

// Org-scoped SSE broadcast. Messages without an orgId are intentionally
// dropped so one org's events can never leak to another's stream.
function broadcastLog(message, details = {}) {
  if (!details.orgId) return;
  const active = getScope();
  if (active && (active.orgId !== details.orgId || (details.workspaceId && details.workspaceId !== active.workspaceId))) return;
  const workspaceId = details.workspaceId || active?.workspaceId || details.orgId;
  const logObj = { timestamp: new Date().toISOString(), message, ...details, workspaceId };
  const data = `data: ${JSON.stringify(logObj)}\n\n`;
  logClients.forEach((client) => {
    if (client.orgId !== details.orgId || (client.workspaceId || client.orgId) !== workspaceId) return;
    try { client.res.write(data); } catch (_) {}
  });
}

// Make broadcastLog available globally so telephony/engine files that fire
// events during WS sessions can reach connected SSE clients without having
// to import this module themselves.
global.broadcastLog = broadcastLog;

module.exports = { broadcastLog, logClients, activeSessionsCount,
  getActiveSessionsCount: () => activeSessionsCount,
  incrementSessions: () => { activeSessionsCount++; },
  decrementSessions: () => { activeSessionsCount = Math.max(0, activeSessionsCount - 1); },
  addLogClient: (client) => { logClients.push(client); },
  removeLogClient: (client) => { logClients = logClients.filter((c) => c !== client); }
};
