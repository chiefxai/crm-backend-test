'use strict';

const crypto = require('node:crypto');

function keyFromEnvironment() {
  const configured = process.env.BILLING_EMAIL_PAYLOAD_KEY;
  if (!configured || configured.length < 32) throw new Error('BILLING_EMAIL_PAYLOAD_KEY must contain at least 32 characters to queue private email payloads.');
  return crypto.createHash('sha256').update(configured).digest();
}

function encryptPayload(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromEnvironment(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
}

function decryptPayload(value) {
  const envelope = typeof value === 'string' ? JSON.parse(value) : value;
  if (!envelope || envelope.version !== 1) throw new Error('Unsupported encrypted billing email payload version.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromEnvironment(), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
}

module.exports = { encryptPayload, decryptPayload };
