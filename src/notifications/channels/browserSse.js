'use strict';
const crypto = require('node:crypto');
const { broadcastNotificationHint } = require('../../shared');
const subscribers = new Set();

function secret() {
  const value = process.env.SSE_TICKET_SECRET || process.env.INTERNAL_API_SECRET;
  if (!value && process.env.NODE_ENV === 'production') throw new Error('SSE_TICKET_SECRET is required for platform notifications.');
  return value || 'dev-sse-ticket-secret';
}
function ticketFor({ userId, email }) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, email, purpose: 'platform-notification-stream', exp: Math.floor(Date.now()/1000)+60, nonce: crypto.randomUUID() })).toString('base64url');
  const signature = crypto.createHmac('sha256',secret()).update(payload).digest('base64url');
  return payload + '.' + signature;
}
function verifyTicket(input) {
  if (typeof input !== 'string' || input.length > 4096) return null;
  const parts = input.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256',secret()).update(parts[0]).digest();
  let provided;
  try { provided=Buffer.from(parts[1], 'base64url'); } catch { return null; }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided,expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
    return payload.purpose === 'platform-notification-stream' && payload.sub &&
      Number.isFinite(payload.exp) && payload.exp > Date.now()/1000 ? payload : null;
  } catch { return null; }
}
function sendRefreshHint({ audience, orgId, workspaceId }) {
  if (audience === 'platform') {
    for (const res of subscribers) {
      try { res.write('event: notification\ndata: {}\n\n'); } catch { subscribers.delete(res); }
    }
    return;
  }
  broadcastNotificationHint({ orgId, workspaceId });
}
function connectPlatformStream(req,res) {
  const token = verifyTicket(req.query.ticket);
  if (!token) return res.status(401).json({ error: 'Notification stream ticket expired or invalid.' });
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache, no-transform');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders?.();
  res.write(': notification stream ready\n\n');
  subscribers.add(res);
  const timer = setInterval(() => res.write(': keepalive\n\n'),25000);
  timer.unref?.();
  req.on('close',() => { clearInterval(timer); subscribers.delete(res); });
}
module.exports = { ticketFor, verifyTicket, sendRefreshHint, connectPlatformStream };