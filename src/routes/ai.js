// src/routes/ai.js — /api/gemini/*, /api/simulate-call, /api/integrations/*

const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { requireAuthOrInternal } = require("../middleware/auth");
const genai = require("../ai/googleAiClient");
const { getLogger } = require("../observability/logger");
const log = getLogger("routes.ai");
const { isVertex } = genai;
// Ready when Vertex AI is configured OR a Gemini API key is present
const aiReady = isVertex || !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY");
const getOrgAiClient = (req) => genai.getClientForOrg(req.orgId || null);
const expensiveAiLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, skip: (req) => !!req.isInternalService, message: { error: "Too many AI requests. Please try again later." } });
const messagingLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, skip: (req) => !!req.isInternalService, message: { error: "Too many messaging requests. Please try again later." } });

function escapeHtml(value) { return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }

// ── Email template builder ──────────────────────────────────────────────────
function getHtmlTemplate(subject, body) {
  const now = new Date();
  const year = now.getFullYear();
  const ts = now.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) + " · " + now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  const lines = (body || "").split("\n").map(l => l.trim()).filter(Boolean);
  const kvPairs = [], freeLines = [];
  for (const line of lines) {
    const sep = line.indexOf(":");
    if (sep > 0 && sep < 45) {
      const k = line.slice(0, sep).trim().replace(/^[*-]\s*/, ""), v = line.slice(sep + 1).trim();
      if (k && v) { kvPairs.push({ key: k, val: v }); continue; }
    }
    freeLines.push(line);
  }
  const nameEntry = kvPairs.find(p => /^(name|caller|customer|client)/i.test(p.key));
  const callerName = nameEntry ? nameEntry.val : "there";
  const safeSubject = escapeHtml(subject || "ChiefVoice");
  const safeFirstName = escapeHtml(callerName.split(" ")[0] || "there");
  const firstName = callerName.split(" ")[0];
  const initials = callerName.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase() || "CV";
  const dots = ["#10b981","#3b82f6","#f59e0b","#ef4444","#8b5cf6","#06b6d4","#ec4899"];
  const tableRows = kvPairs.map(({ key, val }, i) => {
    const dot = dots[i % dots.length];
    const isStatus = /status|stage|lead|captured/i.test(key);
    const valHtml = isStatus ? `<span style="background:rgba(16,185,129,.12);color:#059669;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;">${escapeHtml(val)}</span>` : `<span style="color:#1e293b;font-weight:600;">${escapeHtml(val)}</span>`;
    return `<tr style="background:${i%2===0?"#fff":"#f8fafc"};"><td style="padding:12px 16px;font-size:13px;color:#64748b;font-weight:500;width:40%;border-bottom:1px solid #f1f5f9;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${dot};margin-right:8px;vertical-align:middle;"></span>${escapeHtml(key)}</td><td style="padding:12px 16px;font-size:14px;border-bottom:1px solid #f1f5f9;">${valHtml}</td></tr>`;
  }).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${safeSubject}</title></head><body style="margin:0;padding:0;background:#060818;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" border="0" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:28px 16px 40px;"><table width="100%" style="max-width:600px;"><tr><td style="background:linear-gradient(90deg,#8b5cf6,#3b82f6,#06b6d4,#10b981);height:5px;border-radius:6px 6px 0 0;"></td></tr><tr><td style="background:linear-gradient(140deg,#0d0f2b,#1a1040,#0d1f3c);padding:36px 40px 42px;color:#fff;"><div style="font-size:30px;font-weight:800;">Hi, ${safeFirstName}!</div><div style="color:#94a3b8;font-size:14px;margin-top:8px;">Your ChiefVoice AI call has been processed.</div></td></tr><tr><td style="background:#fff;padding:36px 40px;">${kvPairs.length>0?`<table width="100%" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;border-collapse:collapse;margin-bottom:28px;">${tableRows}</table>`:""} ${freeLines.length>0?`<div style="border-left:4px solid #8b5cf6;padding:18px 22px;background:#f8f4ff;margin-bottom:28px;"><p style="margin:0;font-size:14px;color:#334155;line-height:1.8;">${freeLines.map(escapeHtml).join("<br>")}</p></div>`:""}</td></tr><tr><td style="background:#0d1117;padding:22px 40px;border-radius:0 0 12px 12px;"><div style="color:#c4b5fd;font-size:13px;font-weight:700;">ChiefVoice CRM</div><div style="color:#475569;font-size:11px;float:right;">${ts}</div></td></tr></table></td></tr></table></body></html>`;
}

// ── Send Email ──
router.post("/integrations/send-email", messagingLimiter, requireAuthOrInternal, async (req, res) => {
  const { email, subject, body, documentType } = req.body;
  if (!email || typeof email !== "string" || email.length > 320 || /[\r\n]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Invalid or missing email address" });
  if (subject && (String(subject).length > 500 || /[\r\n]/.test(String(subject)))) return res.status(400).json({ error: "Invalid or too long subject" });
  if (body && String(body).length > 50000) return res.status(400).json({ error: "Email body is too long" });

  const emailSubject = subject || "Requested Document from ChiefVoice";
  const emailBody = body || `Hello,\n\nPlease find attached the requested ${documentType || "document"}.\n\nBest regards,\nChiefVoice Team`;

  global.broadcastLog(`✉️ AI requested email to ${email}`, { type: "email", email });

  // 1. External email relay (optional HTTPS bridge via VERCEL_EMAIL_SERVICE_URL)
  if (process.env.VERCEL_EMAIL_SERVICE_URL) {
    try {
      const r = await fetch(process.env.VERCEL_EMAIL_SERVICE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, subject: emailSubject, body: emailBody, gmailUser: process.env.GMAIL_USER, gmailPass: process.env.GMAIL_PASS }) });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || `Vercel Bridge error (${r.status})`);
      return res.json({ success: true, provider: "vercel_bridge" });
    } catch (err) { log.warn("⚠️ Vercel Bridge failed:", err.message); }
  }

  // 2. Gmail REST API (OAuth2)
  const { GMAIL_CLIENT_ID: cid, GMAIL_CLIENT_SECRET: csec, GMAIL_REFRESH_TOKEN: rtoken, GMAIL_USER: gmailSender = email } = process.env;
  if (cid && csec && rtoken) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 10000);
    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: rtoken, grant_type: "refresh_token" }).toString(), signal: ctrl.signal });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) throw new Error(tokenData.error_description || "Failed to get token");
      const utf8Subject = `=?utf-8?B?${Buffer.from(emailSubject).toString("base64")}?=`;
      const rawMime = [`From: ${gmailSender}`, `To: ${email}`, `Subject: ${utf8Subject}`, "MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: 7bit", "", getHtmlTemplate(emailSubject, emailBody)].join("\r\n");
      const base64 = Buffer.from(rawMime).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
      const gmailRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { "Authorization": `Bearer ${tokenData.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ raw: base64 }), signal: ctrl.signal });
      const gmailData = await gmailRes.json();
      if (!gmailRes.ok || gmailData.error) throw new Error(gmailData.error?.message || "Gmail API error");
      return res.json({ success: true, provider: "gmail_rest", messageId: gmailData.id });
    } catch (err) { log.warn("⚠️ Gmail REST failed:", err.message); }
    finally { clearTimeout(tid); }
  }

  // 3. Resend REST API
  if (process.env.RESEND_API_KEY) {
    try {
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: process.env.RESEND_FROM_EMAIL || "ChiefVoice <onboarding@resend.dev>", to: email, subject: emailSubject, text: emailBody, html: getHtmlTemplate(emailSubject, emailBody) }) });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.message || data.error?.message || "Resend API error");
      return res.json({ success: true, provider: "resend", messageId: data.id });
    } catch (err) { log.warn("⚠️ Resend failed:", err.message); }
  }

  res.status(502).json({ success: false, error: "No email delivery method succeeded." });
});

// ── Send WhatsApp ──
router.post("/integrations/send-whatsapp", messagingLimiter, requireAuthOrInternal, async (req, res) => {
  const { phoneNumber, message, documentUrl, fileName } = req.body;
  if (!phoneNumber || !message) return res.status(400).json({ error: "Missing phoneNumber or message" });
  if (String(message).length > 10000) return res.status(400).json({ error: "WhatsApp message is too long" });

  const sanitized = phoneNumber.replace(/[\s\-\(\)\+]+/g, "");
  global.broadcastLog(`💬 AI requested WhatsApp to ${sanitized}`, { type: "whatsapp", phoneNumber: sanitized });

  if (!process.env.WASENDER_API_KEY) return res.status(502).json({ success: false, error: "WhatsApp is not configured." });

  try {
    const payload = { to: sanitized, text: message };
    if (documentUrl) { payload.documentUrl = documentUrl; payload.fileName = fileName || "Document"; }
    const r = await fetch("https://www.wasenderapi.com/api/send-message", { method: "POST", headers: { "Authorization": `Bearer ${process.env.WASENDER_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await r.json();
    if (!r.ok || !data.success) throw new Error(data.message || `WasenderAPI error (${r.status})`);
    res.json({ success: true, jid: data.data?.jid });
  } catch (err) {
    log.error("❌ WhatsApp send failed:", err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

// ── AI Insights Desk ──
router.post("/gemini/insights", expensiveAiLimiter, requireAuthOrInternal, async (req, res) => {
  const { leads, loans, campaigns, platformMode } = req.body;
  const isInsurance = platformMode === "insurance";

  if (!aiReady) {
    return res.json({ success: true, degraded: true, insights: isInsurance ? "💡 **AI Underwriting Brief (Simulation Mode)**\n\nPipeline metrics are operational." : "💡 **AI Credit Brief (Simulation Mode)**\n\nLoan conversions indicate positive user growth." });
  }

  try {
    const role = isInsurance ? "Chief Underwriting Officer" : "Chief Credit Analyst";
    const terms = isInsurance ? "policy types, risk bands, premiums" : "loan products, balances, interest rates";
    const prompt = `You are the ${role} at ChiefXAI. Analyze this CRM state and provide a strategic brief. Evaluate ${terms}.\nLeads: ${JSON.stringify(leads)}\n${isInsurance?"Policies":"Loans"}: ${JSON.stringify(loans)}\nCampaigns: ${JSON.stringify(campaigns)}`;
    const response = await (await getOrgAiClient(req)).models.generateContent({ model: "gemini-2.5-flash", contents: prompt });
    res.json({ success: true, insights: response.text });
  } catch (_) {
    res.json({ success: true, degraded: true, insights: "💡 Pipeline metrics are operational." });
  }
});

// ── Lead Scoring ──
router.post("/gemini/score-lead", expensiveAiLimiter, requireAuthOrInternal, async (req, res) => {
  const { lead } = req.body || {};

  if (!lead || typeof lead !== "object" || Array.isArray(lead)) {
    return res.status(400).json({ success: false, error: "A lead object is required." });
  }

  if (!aiReady) {
    const score = lead.financialInfo ? Math.max(10, Math.min(100, Math.round((lead.financialInfo.creditScore - 300) / 5.2 + (lead.financialInfo.monthlyIncome > 8000 ? 20 : 5) - lead.financialInfo.debtToIncome * 30))) : 50;
    const tags = score > 85 ? ["Prime-Lead","Low-Risk"] : score < 50 ? ["Subprime","High-DTI"] : ["Standard-Profile"];
    return res.json({ success: true, degraded: true, score, tags, decision: `Offline scoring: Credit score ${lead.financialInfo?.creditScore || "700"} → ${score}/100.` });
  }

  try {
    const { Type } = require("@google/genai");
    const response = await (await getOrgAiClient(req)).models.generateContent({ model: "gemini-2.5-flash", contents: `Assess loan eligibility (0-100): ${JSON.stringify(lead)}`, config: { responseMimeType: "application/json", responseSchema: { type: Type.OBJECT, properties: { score: { type: Type.INTEGER }, tags: { type: Type.ARRAY, items: { type: Type.STRING } }, decision: { type: Type.STRING } }, required: ["score","tags","decision"] } } });
    res.json({ success: true, ...JSON.parse(response.text || "{}") });
  } catch (_) {
    res.status(503).json({ success: false, error: "Lead scoring is unavailable. No score or eligibility decision was produced." });
  }
});

// ── Document OCR/Verification ──
router.post("/gemini/verify-doc", expensiveAiLimiter, requireAuthOrInternal, async (req, res) => {
  const { docType, docName, fileContent } = req.body || {};

  if (typeof docType !== "string" || !docType.trim() || typeof docName !== "string" || !docName.trim() ||
      typeof fileContent !== "string" || !fileContent.trim()) {
    return res.status(422).json({ success: false, error: "Document text is required. Profile data or a file name cannot be used as document evidence." });
  }

  if (!aiReady) {
    return res.status(503).json({ success: false, error: "Document analysis is unavailable. The document was not verified." });
  }

  try {
    const { Type } = require("@google/genai");
    const prompt = `Extract only details explicitly present in this supplied document text. This is extraction, not verification.\nCategory: ${docType}\nFile: ${docName}\nDocument text: "${fileContent}"`;
    const response = await (await getOrgAiClient(req)).models.generateContent({ model: "gemini-2.5-flash", contents: prompt, config: { responseMimeType: "application/json", responseSchema: { type: Type.OBJECT, properties: { extractedName: { type: Type.STRING }, extractedIncome: { type: Type.NUMBER }, extractedEmployer: { type: Type.STRING }, confidenceScore: { type: Type.INTEGER }, issues: { type: Type.ARRAY, items: { type: Type.STRING } } }, required: ["extractedName","confidenceScore","issues"] } } });
    const ocrData = JSON.parse(response.text || "{}");
    if (!ocrData || typeof ocrData.extractedName !== "string" || !Number.isFinite(ocrData.confidenceScore) || !Array.isArray(ocrData.issues)) {
      throw new Error("AI document analysis returned an invalid response.");
    }
    res.json({ success: true, ocrData, status: "Needs Review" });
  } catch (error) {
    log.error("Document analysis failed", { error: error?.message });
    res.status(503).json({ success: false, error: "Document analysis failed. The document was not verified." });
  }
});

// ── Voice Call Simulator ──
router.post(["/simulate-call", "/gemini/simulate-call"], requireAuthOrInternal, async (req, res) => {
  const { leadName, loanAmount, prompt, transcript, customerUtterance } = req.body || {};

  if (typeof leadName !== "string" || !leadName.trim() || !Number.isFinite(Number(loanAmount)) ||
      typeof prompt !== "string" || !Array.isArray(transcript) ||
      !transcript.every((item) => item && typeof item.speaker === "string" && typeof item.text === "string") ||
      typeof customerUtterance !== "string" || !customerUtterance.trim()) {
    return res.status(400).json({ success: false, error: "A lead name, numeric loan amount, prompt, transcript, and customer response are required." });
  }

  if (!aiReady) {
    const lower = customerUtterance.toLowerCase();
    const interested = lower.includes("yes") || lower.includes("sure") || lower.includes("interested");
    const notInterested = lower.includes("no") || lower.includes("stop") || lower.includes("busy");
    return res.json({ success: true, degraded: true, reply: interested ? `That is fantastic! Since you are interested in the $${loanAmount} loan, I am sending an upload link now.` : notInterested ? "I completely understand. I will close your file. Thanks for your time, goodbye!" : `Hello ${leadName}, I've noted your details. Let's touch base again soon.`, sentiment: interested ? "Positive" : notInterested ? "Negative" : "Neutral", intent: interested ? "Interested" : notInterested ? "Not Interested" : "Unknown", isFinished: notInterested });
  }

  try {
    const { Type } = require("@google/genai");
    const formattedTranscript = transcript.map(t => `${t.speaker}: ${t.text}`).join("\n");
    const convPrompt = `You are an AI calling agent for ChiefXAI. You are calling ${leadName} about their $${loanAmount} loan request.\nPersona: ${prompt}\nTranscript:\n${formattedTranscript}\nCustomer: "${customerUtterance}"\nGenerate a brief reply (1-2 sentences) and analyze sentiment and intent. Output as JSON.`;
    const response = await (await getOrgAiClient(req)).models.generateContent({ model: "gemini-2.5-flash", contents: convPrompt, config: { responseMimeType: "application/json", responseSchema: { type: Type.OBJECT, properties: { reply: { type: Type.STRING }, sentiment: { type: Type.STRING, enum: ["Positive","Neutral","Negative"] }, intent: { type: Type.STRING, enum: ["Interested","Not Interested","Callback Scheduled","Wrong Number","Unknown"] }, isFinished: { type: Type.BOOLEAN } }, required: ["reply","sentiment","intent","isFinished"] } } });
    res.json({ success: true, ...JSON.parse(response.text || "{}") });
  } catch (_) {
    res.json({ success: true, degraded: true, reply: "I see. I will document this on your profile.", sentiment: "Neutral", intent: "Unknown", isFinished: false });
  }
});

module.exports = router;
