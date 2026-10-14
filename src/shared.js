const { getScope } = require("./workspaces/scope");
// Shared mutable server state — passed between the HTTP layer and WebSocket
// handlers. Kept in one place so route files and WS handlers all reference
// the same instances rather than creating independent copies.

let activeSessionsCount = 0;
let logClients = []; // [{ res, orgId }]

// Org-scoped SSE broadcast. Messages without an orgId are intentionally
// dropped so one org's events can never leak to another's stream.
function broadcastLog(message, details = {}) {
  const active = getScope();
  // Request-scoped callers may omit tenant fields because the authenticated
  // middleware has already bound them to AsyncLocalStorage. Background work
  // still has to supply an explicit trusted org; never infer one globally.
  const orgId = details.orgId || active?.orgId;
  if (!orgId) return;
  if (active && (active.orgId !== orgId || (details.workspaceId && details.workspaceId !== active.workspaceId))) return;
  const workspaceId = details.workspaceId || active?.workspaceId || orgId;
  const logObj = { timestamp: new Date().toISOString(), message, ...details, orgId, workspaceId };
  const data = `data: ${JSON.stringify(logObj)}\n\n`;
  logClients.forEach((client) => {
    if (client.orgId !== orgId || (client.workspaceId || client.orgId) !== workspaceId) return;
    try { client.res.write(data); } catch (_) {}
  });
}

// A named SSE signal carries no notification body. Clients refresh their own
// authorized, preference-filtered feed from /api/notifications.
function broadcastNotificationHint({ orgId, workspaceId = null }) {
  if (!orgId) return;
  for (const client of logClients) {
    if (client.orgId !== orgId) continue;
    if (workspaceId && client.workspaceId !== workspaceId) continue;
    try { client.res.write('event: notification\\ndata: {}\\n\\n'); } catch (_) { /* client disconnected */ }
  }
}

// Make broadcastLog available globally so telephony/engine files that fire
// events during WS sessions can reach connected SSE clients without having
// to import this module themselves.
global.broadcastLog = broadcastLog;

module.exports = { broadcastLog, broadcastNotificationHint, logClients, activeSessionsCount,
  getActiveSessionsCount: () => activeSessionsCount,
  incrementSessions: () => { activeSessionsCount++; },
  decrementSessions: () => { activeSessionsCount = Math.max(0, activeSessionsCount - 1); },
  addLogClient: (client) => { logClients.push(client); },
  removeLogClient: (client) => { logClients = logClients.filter((c) => c !== client); }
};
