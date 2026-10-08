// src/email/mailer.js — nodemailer wrapper
//
// Required env vars:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//
// Optional:
//   SMTP_SECURE — "true" for port 465 TLS (default false)
//   APP_URL     — public frontend URL in emails (see src/email/appUrl.js)
//   FRONTEND_URL / PUBLIC_APP_URL — optional aliases
//   ALLOWED_ORIGINS — first origin used if APP_URL is unset

const nodemailer = require("nodemailer");
const { getLogger } = require("../observability/logger");
const log = getLogger("email.mailer");

let _transporter = null;

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587", 10),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return _transporter;
}

async function sendMailResult({ to, subject, html, text }) {
  if (!isConfigured()) {
    log.warn("⚠️  SMTP not configured — email skipped:", subject, "→", to);
    return { status: "skipped_unconfigured", providerMessageId: null, retryable: false, errorCode: null };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    const result = await getTransporter().sendMail({ from, to, subject, html, text });
    log.info(`📧 Email accepted: "${subject}" → ${to}`);
    return { status: "submitted", providerMessageId: result?.messageId || null, retryable: false, errorCode: null };
  } catch (error) {
    const code = String(error?.code || "SMTP_SEND_FAILED").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96);
    const retryable = error?.responseCode >= 400 && error?.responseCode < 500 || ["ETIMEDOUT", "ECONNECTION", "ECONNRESET", "EHOSTUNREACH", "ESOCKET"].includes(error?.code);
    log.warn(`Email submission failed (${code}) for ${to}`);
    return { status: "failed", providerMessageId: null, retryable, errorCode: code };
  }
}

async function sendMail(message) {
  const result = await sendMailResult(message);
  if (result.status === "failed") {
    const error = new Error(`Email submission failed: ${result.errorCode}`);
    error.code = result.errorCode;
    throw error;
  }
  return result;
}

module.exports = { sendMail, sendMailResult, isConfigured };
