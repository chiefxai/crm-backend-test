// src/email/templates.js — HTML email templates

const { getPublicAppUrl, escapeHtml } = require("./appUrl");

const PRODUCT_NAME = process.env.EMAIL_PRODUCT_NAME || "ChiefVoice";

function welcomeEmail({ orgName, adminEmail, tempPassword, role }) {
  const appUrl = getPublicAppUrl();
  const safeOrg = escapeHtml(orgName || "your organization");
  const safeEmail = escapeHtml(adminEmail);
  const safePassword = escapeHtml(tempPassword);
  const safeRole = role ? escapeHtml(role) : "";
  const subject = `You're invited to ${orgName || "your workspace"} on ${PRODUCT_NAME}`;

  const roleLine = safeRole
    ? `<p class="role-pill">${safeRole} · ${safeOrg}</p>`
    : `<p class="role-pill">${safeOrg}</p>`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="light"/>
  <title>${escapeHtml(subject)}</title>
  <style>
    body{margin:0;padding:0;background:#eef2ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
    .outer{padding:32px 16px}
    .wrap{max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 8px 30px rgba(15,23,42,.06)}
    .header{background:linear-gradient(135deg,#4f46e5 0%,#6366f1 50%,#7c3aed 100%);padding:32px 36px 28px;color:#fff}
    .brand{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;opacity:.9;margin:0 0 8px}
    .header h1{margin:0;font-size:24px;font-weight:800;line-height:1.25;letter-spacing:-.02em}
    .header .sub{margin:10px 0 0;font-size:14px;line-height:1.5;opacity:.92}
    .body{padding:32px 36px 28px}
    .body p{margin:0 0 14px;color:#334155;font-size:15px;line-height:1.65}
    .role-pill{display:inline-block;margin:0 0 20px;padding:6px 12px;background:#eef2ff;color:#4338ca;font-size:12px;font-weight:600;border-radius:999px;border:1px solid #c7d2fe}
    .creds-box{border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin:8px 0 24px;background:#f8fafc}
    .creds-header{padding:12px 18px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;background:#f1f5f9;border-bottom:1px solid #e2e8f0}
    .cred-row{padding:14px 18px;border-top:1px solid #e2e8f0}
    .cred-row:first-of-type{border-top:none}
    .cred-label{display:block;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
    .cred-value{display:block;font-size:15px;color:#0f172a;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all;line-height:1.4}
    .btn-wrap{margin:24px 0 8px;text-align:center}
    .btn-primary{display:inline-block;background:#4f46e5;color:#ffffff !important;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;box-shadow:0 4px 14px rgba(79,70,229,.35)}
    .url-hint{margin:16px 0 0;text-align:center;font-size:12px;color:#64748b;line-height:1.5}
    .url-hint a{color:#4f46e5;word-break:break-all}
    .note{margin-top:20px;padding:14px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;font-size:13px;color:#92400e;line-height:1.55}
    .footer{padding:22px 36px;text-align:center;font-size:12px;color:#94a3b8;line-height:1.6;background:#f8fafc;border-top:1px solid #e2e8f0}
  </style>
</head>
<body>
  <div class="outer">
    <div class="wrap">
      <div class="header">
        <p class="brand">${escapeHtml(PRODUCT_NAME)}</p>
        <h1>Your workspace access is ready</h1>
        <p class="sub">An administrator added you to <strong>${safeOrg}</strong>. Use the credentials below to sign in.</p>
      </div>

      <div class="body">
        <p>Hi there,</p>
        ${roleLine}

        <div class="creds-box">
          <div class="creds-header">Sign-in credentials</div>
          <div class="cred-row">
            <span class="cred-label">Email</span>
            <span class="cred-value">${safeEmail}</span>
          </div>
          <div class="cred-row">
            <span class="cred-label">Temporary password</span>
            <span class="cred-value">${safePassword}</span>
          </div>
        </div>

        <div class="btn-wrap">
          <a href="${escapeHtml(appUrl)}" class="btn-primary">Sign in to ${escapeHtml(PRODUCT_NAME)}</a>
        </div>
        <p class="url-hint">Or open this link in your browser:<br/><a href="${escapeHtml(appUrl)}">${escapeHtml(appUrl)}</a></p>

        <div class="note">
          For security, you may be asked to set a new password after your first sign-in. Do not share this email.
        </div>
      </div>

      <div class="footer">
        ${escapeHtml(PRODUCT_NAME)} · Sent because an admin created an account for this address.<br/>
        If you did not expect this invitation, you can ignore this message.
      </div>
    </div>
  </div>
</body>
</html>`;

  const text = [
    `Your ${PRODUCT_NAME} account for ${orgName || "your organization"} is ready.`,
    safeRole ? `Role: ${role}` : "",
    "",
    `Email: ${adminEmail}`,
    `Temporary password: ${tempPassword}`,
    "",
    `Sign in: ${appUrl}`,
    "",
    "You may be asked to change your password after the first login.",
  ].filter((line) => line !== "").join("\n");

  return { subject, html, text };
}

function welcomeOrganization(opts) {
  return welcomeEmail({ ...opts, role: "Organization Admin" });
}

module.exports = { welcomeEmail, welcomeOrganization };
