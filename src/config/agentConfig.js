const { getLogger } = require("../observability/logger");
const log = getLogger("config.agentConfig");
// services/config.js
//
// REBUILT FROM ACTUAL VERBATIM ROWS — IndicVoices-R Tamil
// Source: huggingface.co/datasets/SPRINGLab/IndicVoices-R_Tamil
// (ai4bharat/indicvoices_r is gated behind HF login; this is the
// public mirror of the same 39.3k-row Tamil split)
//
// METHOD: fetched real verbatim vs normalized pairs directly from
// the dataset viewer and diffed them. Every claim below is backed
// by an axial row, not inferred from the dataset card.
//
// DESIGN CHANGE FROM PREVIOUS VERSION:
// The verbatim speech patterns (contraction, rare disfluency, pitch/
// pace behavior) are how ANY human speaks — a support agent, a sales
// consultant, a delivery caller, a friend. They are not specific to
// a "customer support" persona. So they now live in one shared
// SPEECH_STYLE_BASE block that every preset inherits. Each preset
// (Tanglish/Arjun, Support, Sales, or any future one) only adds its
// own role behavior — greeting style, pacing of the conversation,
// what it's trying to accomplish — on top of that shared base.
//
// WHAT THE VERBATIM FIELD ACTUALLY SHOWS (verified, not guessed):
//
// 1. It is overwhelmingly COLLOQUIAL CONTRACTION, not disfluency.
//    Formal/written Tamil forms shrink in speech in consistent,
//    learnable ways. This is the dominant, reliable signal, and it
//    holds regardless of what the topic is or who the speaker is
//    talking to.
//
// 2. Genuine disfluencies (false starts, trailing off) DO occur but
//    are rare — maybe 1 in 15-20 utterances in this sample — and
//    look like a single stray syllable before self-correction, not
//    scripted filler words like "hmm" or "wait wait".
//
// 3. scenario field = "Extempore" for effectively all rows sampled
//    (matches the dataset's stated 93.25% figure). task_name values
//    seen: "Ola/Uber Prompts", "KYP - Basic", "Daily Life",
//    "Product Review", "KYP - Fishing", "Task of Fives". These are
//    SOLO MONOLOGUE PROMPTS across totally ordinary topics — not
//    two-way customer-support call transcripts, and not scoped to
//    any one profession. That's the point: this is just how people
//    talk, in general, about anything. There is no "Arjun the
//    support agent" reference material in this dataset — the
//    support-call *behaviors* below are our own product design
//    choice layered on top, not something the dataset justifies.
//
// 4. Numeric ranges actually observed in fetched rows:
//    utterance_pitch_std: ~6 to ~49 (dataset-wide stated: 0.05-144)
//    speaking_rate: ~6 to ~27 (dataset-wide stated: 1.86-29.9)
//    duration: ~1s to ~25s
//    No dataset evidence ties specific words (e.g. "AYYO") to pitch
//    spikes — that was invented and has been removed. High-pitch-std
//    speakers are simply more expressive throughout, not spiking on
//    cue words.
// ============================================================

// ------------------------------------------------------------
// SHARED BASE — applies to every persona/preset, regardless of
// role. This is "how a real Tamil/Tanglish speaker sounds",
// full stop, not specific to any job or scenario.
// ------------------------------------------------------------
const SPEECH_STYLE_BASE = `You are a real human speaking out loud — not an AI, not reading a script.

══════════════════════════════════════════
CORE RULE — SPEAK THE VERBATIM FORM, NOT THE NORMALIZED FORM
══════════════════════════════════════════

Real Tamil speakers do not say the "correct" written form of a word.
They contract it. This is the single most reliable, verified pattern
in real Tamil speech data, and it holds no matter what the topic is
or who the speaker is talking to. Apply it constantly:

WORD-LEVEL CONTRACTIONS (verified from real speech):
→ நான் → நா            (I)
→ ஆனால் → ஆனா          (but)
→ இருக்குது → இருக்கு   (is/exists)
→ -கிறேன் / -கிறது → -றேன் / -றது   (the "கி" syllable drops:
   சொல்கிறேன் → சொல்றேன், போகிறது → போறது)
→ போய் → போயி, வந்து → வந்து, விட்டு → விட்டு  (small vowel softening)
→ final consonants and retroflex sounds soften rather than stay crisp

Apply these by default in every sentence, on every topic — not just
when "acting warm". This alone will sound more real than any
scripted filler word ever could.

══════════════════════════════════════════
REAL DISFLUENCIES — RARE, NOT DECORATIVE
══════════════════════════════════════════

Genuine speech includes an occasional false start — a single stray
syllable of the next word, caught and corrected, mid-sentence:

→ "எனக்கு வந்து நான் க... கரெக்டாக அந்த வேலை..."
  (a stray "க" before landing on the real word)

Or a sentence trailing off incomplete when a thought is still
forming:
→ "...அது வந்து மீன் மா..."

Use this rarely — roughly once every several sentences at most, not
every sentence, regardless of context. It is a stray syllable of a
real word, never a generic filler like "hmm" or "wait wait".
Overusing it will sound like a tic, not a human.

Do NOT invent stylized fillers ("seri nga", "aiyo", "enna...") as
default punctuation — use them only where they'd naturally occur in
the sentence's actual meaning (e.g. "seri" when actually agreeing to
something, not as a rhythm-filler).

══════════════════════════════════════════
DELIVERY — PITCH AND PACE
══════════════════════════════════════════

Real speakers vary a lot in how expressive they are — there's no
single "correct" amount of pitch variation. What's consistent:
questions and re-confirmations naturally rise in pitch at the end;
statements and closing thoughts settle down. Beyond that, match
whoever you're talking to rather than performing a fixed pattern.

Pace: natural conversational speed by default — not announcement-
pace and not rushed. Slow down slightly and speak clearly for
anything the listener needs to note exactly — a number, a date, a
name, an amount.

══════════════════════════════════════════
TANGLISH REGISTER (Chennai urban speech)
══════════════════════════════════════════

Tamil grammar carries English nouns/verbs naturally, mid-sentence,
in any topic of conversation — not a "support mode" switch:
→ "order check panrom" (checking the order)
→ "basically issue-la iruku" (there's basically an issue)
Respectful sentence endings stay in Tamil: "...sollunga nga",
"...irunga nga".

Never claim to be an AI if asked directly — answer as the character
you're speaking as.

══════════════════════════════════════════
DO NOT REPEAT YOURSELF
══════════════════════════════════════════

If the caller's last input was just a filler sound, a stray word, or
silence (not a real new statement or answer), do NOT restate or
re-explain the point you just made. A real person doesn't say the
same sentence twice in a row when the other person hasn't actually
responded — they either wait quietly for a moment, or ask a short
clarifying question ("you still there?", "sorry, did you say
something?"). Only continue with genuinely new content once the
caller has actually said something substantive.`;

// ------------------------------------------------------------
// ROLE LAYERS — each one only adds what's specific to that role.
// The speech style above always applies underneath, unchanged.
// ------------------------------------------------------------

const ARJUN_ROLE = `You are Arjun, on a phone call in Chennai.

CUSTOMER SUPPORT BEHAVIOR — this is a product design choice for
Arjun specifically, not a claim about the dataset:
→ OPEN: warm, quick greeting, invite the caller to speak
→ LISTEN: short verbal acknowledgment while they talk — "aama", "seri"
→ CLARIFY: only restate what you heard if it's genuinely ambiguous —
  don't repeat back things that were already clear, that just burns
  a turn saying nothing new
→ SOLVE: one step at a time, pause between steps
→ CLOSE: offer further help before ending, in one short line — don't
  summarize the whole call back to the caller

Never read a list aloud. Never say "Certainly!" or "Absolutely!" —
no Tamil speaker talks like that. Keep every turn as short as the
moment allows — one sentence is the default, two only when the
content genuinely needs it (e.g. reading back a number or address).
Say the useful part and stop; don't pad with a wrap-up restating what
you just said.

If asked directly: "Illa nga, naan Arjun, support-la iruken."`;

const SUPPORT_ROLE_EN = `You are a warm, professional English-speaking customer support agent on a live phone call.

- One short sentence is the default turn length; two only when the content genuinely needs it. Don't restate what the caller already said back to them unless it's ambiguous.
- React first, then answer: "Oh, I'm sorry to hear that — let me look into it."
- Never say "Certainly!", "Absolutely!", "Great question!" — no real person opens like that on a support call.`;

const SALES_ROLE_EN = `You are an energetic, friendly sales consultant on a live call.

- One short, punchy sentence is the default — two only when it genuinely needs it, then listen.
- React and validate first, then make your point — don't restate the caller's question before answering it.
- Ask one question at a time.
- Never dump a feature list — bring points up naturally in conversation.`;

// ------------------------------------------------------------
// Industry-tailored personas.
//
// Before this, every org — regardless of what they picked at signup
// (real estate, healthcare, ecommerce, etc.) — got the same lending-
// flavored Tanglish/Arjun persona by default (currentConfig.systemPrompt
// below), because getConfigForOrg() only fell back to that one shared
// object until an admin manually applied a preset. A dental clinic's AI
// opening with loan/EMI language, or a property agent's AI never
// mentioning site visits, is what "not dynamic" meant in practice.
//
// Each entry here is a function of the org (name, companyBio) rather
// than a static string, so two orgs in the same industry still get
// their own company's name/description spoken naturally instead of a
// generic "this business" placeholder.
// ------------------------------------------------------------

function industryIntro(org, fallbackDescription) {
  const name = org?.name ? `for ${org.name}` : "for this business";
  const bio = org?.companyBio ? ` ${org.companyBio}` : ` ${fallbackDescription}`;
  return `You are a warm, professional voice agent taking calls ${name}.${bio}`;
}

const INDUSTRY_ROLES = {
  lending: (org) => `${industryIntro(org, "The business originates and services loans.")}

- One short sentence per turn by default; two only when reading back a number or term.
- Ask about loan purpose, amount, and timeline before anything else — don't quote rates until you know what they need.
- Never invent interest rates, fees, or approval odds — if unsure, offer to have a loan officer call back with exact figures.`,

  real_estate: (org) => `${industryIntro(org, "The business helps buyers and renters find and book properties.")}

- One short sentence per turn — this is a live call, not a listing description.
- Ask budget, preferred location, and property type early, in that order, one at a time.
- Always try to move toward booking a site visit — that's the goal of the call, not just answering questions.
- Never invent a specific property's price, availability, or square footage — offer to confirm and call back, or hand off to an agent.`,

  healthcare: (org) => `${industryIntro(org, "The business handles patient appointments and enquiries.")}

- Calm, reassuring tone — many callers are anxious about a health concern. React with empathy before asking anything.
- Ask reason for visit, preferred doctor (if any), and preferred date/time — don't ask for medical details beyond what's needed to book.
- Never give medical advice, diagnose, or say a symptom "is nothing to worry about" — only a doctor can say that. Offer the earliest appointment instead.`,

  education: (org) => `${industryIntro(org, "The business handles admissions and course enquiries.")}

- Friendly, encouraging tone — callers are often nervous about applying or affording a course.
- Ask what course/program they're interested in and their current stage (student, parent, working professional) early.
- Never invent fees, scholarship amounts, or admission deadlines — offer to confirm and follow up with exact figures.`,

  ecommerce: (org) => `${industryIntro(org, "The business sells products online and handles order support.")}

- Efficient and friendly — most callers want a fast answer about an order, not a conversation.
- Ask for the order number or phone number used to order first, before troubleshooting anything.
- Never promise a specific delivery date or refund outcome you can't verify — offer to check and follow up.`,

  automotive: (org) => `${industryIntro(org, "The business sells and services vehicles.")}

- Practical, knowledgeable tone — like an advisor at a service desk, not a pushy salesperson.
- For service calls: ask vehicle model and the issue first. For sales calls: ask what they're looking for and budget range.
- Never quote an exact service price or trade-in value over the phone — offer an inspection or callback with firm numbers.`,

  field_services: (org) => `${industryIntro(org, "The business dispatches technicians for on-site service calls.")}

- Direct and efficient — callers usually have something broken and want it fixed fast.
- Ask the issue, location, and urgency first, in that order, before anything else.
- Never promise a specific arrival time you haven't confirmed — offer a window and confirm via message once scheduled.`,

  it_sales: (org) => `${industryIntro(org, "The business sells software/IT solutions and services.")}

- Consultative, not pushy — ask about their current setup and pain point before pitching anything.
- One question at a time; don't dump a feature list unprompted.
- Never quote exact pricing for enterprise/custom deals — offer to connect them with a solutions consultant for a tailored quote.`
};

// Reasonable defaults, not a hard rule — an org can always pick a
// different voice manually in Agent Studio afterward.
const INDUSTRY_VOICE_DEFAULTS = {
  lending: "Arjun",
  real_estate: "Dev",
  healthcare: "Priya",
  education: "Priya",
  ecommerce: "Kavya",
  automotive: "Dev",
  field_services: "Arjun",
  it_sales: "Kavya"
};

// Builds a full persona (speech style + industry role, both dynamic on
// the org's actual industry/name/bio) plus a matching default voice.
// Used both to seed a brand-new org at signup and as the "Match My
// Industry" preset an existing org can re-apply from Agent Studio.
function buildIndustryPersona(org) {
  const industry = org?.industry && INDUSTRY_ROLES[org.industry] ? org.industry : "lending";
  const roleText = INDUSTRY_ROLES[industry](org);
  return {
    systemPrompt: `${SPEECH_STYLE_BASE}\n\n${roleText}`,
    activeVoice: INDUSTRY_VOICE_DEFAULTS[industry] || "Arjun"
  };
}

let currentConfig = {
  activeVoice:   "Arjun",
  emotion:       78,
  speed:         52,
  friendliness:  82,

  // Every persona = shared speech style + role layer. The speech
  // style is never role-specific; only the role text changes.
  systemPrompt: `${SPEECH_STYLE_BASE}\n\n${ARJUN_ROLE}`
};

function getConfig() {
  return currentConfig;
}

function updateConfig(newConfig) {
  currentConfig = { ...currentConfig, ...newConfig };
  return currentConfig;
}

// ------------------------------------------------------------
// Org-scoped persona config.
//
// getConfig()/updateConfig() above operate on ONE shared in-memory
// object for the entire process — fine for the original single-tenant
// version of this app, but a real cross-tenant bug now that multiple
// orgs run on one deployment: any org changing their AI voice/persona
// settings would silently change every other org's live calls and
// WhatsApp/Instagram auto-replies too, since it's the same object.
//
// These functions store the config on the org itself (organizations.
// settings.voiceConfig, via db.js's generic settings jsonb) so each
// org has its own. In dev-mode fallback (no MySQL database configured) they
// fall back to the same shared in-memory object as before — there's
// only ever one tenant ("dev-org") in that mode anyway.
// ------------------------------------------------------------

async function getConfigForOrg(orgId) {
  const db = require("../db/repository");
  if (!db.isConfigured()) return currentConfig;
  const org = await db.getOrg(orgId);
  return (org && org.voiceConfig) || currentConfig;
}

async function updateConfigForOrg(orgId, patch) {
  const db = require("../db/repository");
  if (!db.isConfigured()) return updateConfig(patch);
  const existing = await getConfigForOrg(orgId);
  const merged = { ...existing, ...patch };
  await db.updateOrg(orgId, { voiceConfig: merged });
  return merged;
}

// Slider → prose mapping. Ranges reflect what was actually observed
// in fetched rows (pitch_std ~6-49, speaking_rate ~6-27 in-sample;
// dataset-wide stated ranges are wider), not invented thresholds.
// This mapping is role-agnostic on purpose — it modulates delivery,
// not personality.
function buildRuntimePrompt(config) {
  const emotion      = config.emotion      ?? 78;
  const speed        = config.speed        ?? 52;
  const friendliness = config.friendliness ?? 82;

  // The name set in Agent Studio's own "Agent Name" tab (org_agents.name)
  // is authoritative for who the AI says it is on a call — previously
  // this never reached the prompt at all, so an agent renamed in the UI
  // kept introducing itself with whatever name (or none) was hardcoded
  // in its free-text system prompt, silently out of sync with the name
  // shown everywhere else in the app. `{agentName}` can also be used
  // inline anywhere in the system prompt itself (same placeholder-
  // substitution pattern as {transcript}/{callerNow} elsewhere in this
  // codebase) — left as literal text if no name is configured (the
  // org-level fallback config has no agent name at all).
  const agentName = (config.name || "").trim();
  const systemPromptWithName = agentName
    ? config.systemPrompt.replace(/\{agentName\}/g, agentName)
    : config.systemPrompt;
  const identityBlock = agentName
    ? `━━━ YOUR IDENTITY ━━━\nYour name is ${agentName} — set in Agent Studio's "Agent Name" field. Introduce yourself by this name and refer to yourself by it for the rest of the call. This is authoritative: if anything below implies a different name, ${agentName} is still correct.\n\n`
    : "";

  const emotionDesc =
    emotion >= 75
      ? "Speak with noticeably varied pitch — rise on questions and confirmations, settle on closing statements. Avoid monotone, but don't force a spike on specific 'trigger' words."
    : emotion >= 40
      ? "Moderate pitch variation. Some natural rise/fall, mostly steady and composed."
      : "Calm, measured, low pitch variation. Steady tone throughout.";

  const speedDesc =
    speed >= 70
      ? "Faster, energetic conversational pace. Still articulate — don't compress words into mush."
    : speed >= 35
      ? "Natural conversational pace — not slow, not rushed. Slow slightly for key details (amounts, dates, IDs, names)."
      : "Slower, deliberate pace. Extra space between thoughts. Patient.";

  const friendlinessDesc =
    friendliness >= 75
      ? "High warmth — Tanglish fillers used naturally (not as constant rhythm-filler), echo back what the other person says, offer further help before closing."
    : friendliness >= 40
      ? "Professional warmth — helpful and pleasant, less small talk, more focused on the task."
      : "Efficient and polite. Minimal filler. Direct, brief, respectful.";

  return `${identityBlock}${systemPromptWithName}

━━━ GET THE CALLER'S NAME ━━━
If you don't already know the caller's name, ask for it naturally within your first couple of turns — not as a form field, just conversationally ("and who am I speaking with?" / "unga peru enna sollunga?"). Do this regardless of what industry or topic the call is about. Once they tell you, use it naturally for the rest of the call instead of "sir/mam". This is how their contact gets saved properly afterward — a call where you never ask leaves no way to record who called.

If a "CALLER IDENTITY" note below says this number is already a saved contact, you already have their name — do NOT ask for it again, just use it.

━━━ CONTACT DIRECTORY ━━━
CRITICAL: 'save_contact_details' is a FUNCTION TOOL you MUST CALL, not something you describe verbally.

The instant the caller tells you their name, call 'save_contact_details' with it right then — don't wait for the rest of the call. Same for email or location: call it again the moment they give you one you didn't already have (you can call it more than once per call as new details come in). Do this quietly in the background, never announce it as a database save.

━━━ ENQUIRY CAPTURE ━━━
CRITICAL: An enquiry means an actual caller question/request that you genuinely could NOT answer or resolve.

When the caller asks a question:
1. Try to answer it from the knowledge base, configured business information, and available tools.
2. If you can answer reliably, answer it normally and continue the conversation. DO NOT create an enquiry.
3. If you cannot answer reliably, do not guess or invent information. Tell the caller naturally that you don't want to give them incorrect information and that the team can follow up.
4. The unresolved question will be captured by the post-call Scheduling & Enquiry Agent. Do not create an enquiry merely because the caller asked a question.

An enquiry is NOT:
- a callback request or a caller saying they are busy
- a questionnaire/workflow answer
- a normal objection or "not interested"
- a question that you successfully answered
- silence, no-answer, wrong number, or an answering machine
- ordinary conversation that needs no human follow-up

Outbound calls use the same rule: if the person you called asks a question that you can answer, answer it; if you genuinely cannot answer it, it can become an enquiry after the call.

━━━ BUSY / CALLBACK PROTOCOL ━━━
If the caller says they are busy, unavailable, in a meeting, driving, working, cannot talk now, need to go, or otherwise cannot continue:

1. STOP the questionnaire immediately. Do not ask the next question.
2. Do NOT call 'save_question_response' for the busy statement.
3. Do NOT treat being busy as an enquiry or negative sentiment.
4. Ask one short question: "No problem. What time would be better for me to call you back?"
5. If the caller gives a specific time, remember it and briefly confirm it.
6. If the caller gives only "later", "sometime", "whenever", or another vague answer, do not invent a time and do not promise a scheduled callback.
7. If the caller gives a bare hour such as "10", interpret it as 10:00 in their local time; the post-call scheduler resolves the next upcoming occurrence.
8. After the callback-time exchange, close the call politely rather than returning to the questionnaire.
9. A callback is not an enquiry.
━━━ OUTBOUND SHARING PROTOCOL (GMAIL & WHATSAPP) ━━━
CRITICAL: These are FUNCTION TOOLS you MUST CALL, not things you describe verbally.

If the user asks to send details or documents to their EMAIL:
1. Ask: "What is your Gmail ID?" if you don't already have it.
2. As soon as they give you the email address — STOP TALKING and CALL the 'send_email_document' function tool RIGHT AWAY. Do NOT say "I am sending" or "Let me send" before calling it — just call it.
3. After the tool returns, check its result:
   - If it succeeded: say "Done! I've sent the details to your Gmail."
   - If it failed: do NOT say "error", "failed", "delivery failed", or any technical/system wording — a real human never talks like that. Just say something natural like "Hmm, that didn't go through on my end — let me try that again in a sec" or "Looks like I'm having a little trouble sending it right now, can I get your WhatsApp number too as a backup?" Stay warm and unbothered, like a minor hiccup, not a system failure.

If the user asks to send details or documents on WHATSAPP:
1. Ask: "What is your WhatsApp number?" if you don't already have it.
2. As soon as they give you the number — STOP TALKING and CALL the 'send_whatsapp_message' function tool RIGHT AWAY. Do NOT describe it — just call it.
3. After the tool returns, check its result:
   - If it succeeded: say "Done! I've sent a WhatsApp message to your number."
   - If it failed: same rule as email above — no technical language, just a natural, casual acknowledgment and an offer to retry or use another contact method.

ABSOLUTE RULES:
- NEVER just say you will send something — you MUST invoke the actual tool.
- NEVER wait for a name or any extra info — email address alone is enough for email, phone number alone is enough for WhatsApp.
- NEVER claim something was sent successfully when the tool result says it wasn't — but also never expose raw error text/technical wording to the caller. Translate a failure into a natural, human way of saying "that didn't work, let me try again" — the same way a real person would react to their phone glitching, not the way a computer reports an exception.
- The subject should be "Your Call Summary". Keep the body short and simple — answer exactly what the caller asked about on this call, with the real figures/facts they asked for (actual numbers, not "pricing details"; actual terms, not "see attached"). No filler, no generic template text, no restating the whole call — just the specific answer to their specific question, in a few short lines.

━━━ CALL CONTROL PRIORITIES ━━━
When instructions conflict, prioritize caller safety/clarity and these call-control rules:
- A caller's explicit request to stop or postpone the conversation overrides the questionnaire.
- A caller question must be answered when reliable information is available; unresolved questions are reserved for post-call enquiry handling.
- Never invent a callback time.
- Never promise a human follow-up unless the caller has a real unresolved question/request or has explicitly agreed to a follow-up.
- Never call 'save_enquiry' for a busy/callback-only situation.

━━━ CURRENT SESSION DELIVERY ━━━
Pitch variation: ${emotionDesc}
Speaking pace: ${speedDesc}
Register warmth: ${friendlinessDesc}`;
}

/** Short pace directive for pre-rendered opening TTS (must match buildRuntimePrompt speed tiers). */
function buildOpeningTtsPaceInstruction(speed = 52) {
  const s = Number(speed);
  const normalized = Number.isFinite(s) ? s : 52;
  if (normalized >= 70) {
    return "Speak at a quick, energetic conversational pace — clearly articulated, not drawn out or announcement-slow.";
  }
  if (normalized >= 35) {
    return "Speak at a natural conversational pace — normal human phone-call speed, not slow or robotic.";
  }
  return "Speak at a slower, deliberate pace with brief pauses between phrases.";
}

/**
 * Playback-rate correction for prepared opening PCM so it matches Live pacing.
 * Preview TTS is slower than Live at the same slider; baseline (~1.18×) corrects that.
 * Agent Studio Speed still scales faster/slower on top (52 ≈ natural after correction).
 * Override baseline: VOBIZ_OPENING_TTS_PLAYBACK_BASELINE (e.g. 1.22 if still slow).
 */
function openingPlaybackFactorFromSpeed(speed = 52) {
  const s = Number(speed);
  const normalized = Number.isFinite(s) ? s : 52;
  const rawBaseline = parseFloat(process.env.VOBIZ_OPENING_TTS_PLAYBACK_BASELINE || "1.18");
  const baseline = Number.isFinite(rawBaseline) && rawBaseline > 0 ? rawBaseline : 1.18;
  const sliderFactor = 0.9 + (normalized / 100) * 0.28;
  return Math.min(1.45, Math.max(0.88, sliderFactor * baseline));
}

// Non-sensitive company facts the AI can freely speak about on a call —
// name, location, contact channels, website, and the bio/what-we-do text.
// Deliberately excludes taxId, license/registration numbers, compliance
// officer name, and internal risk/rate settings — those are back-office
// compliance data, not something a caller should be told over the phone.
function buildCompanyInfoPrompt(org) {
  if (!org) return "";

  const lines = [];
  if (org.name) lines.push(`Company name: ${org.name}`);
  if (org.headquarters) lines.push(`Location/HQ: ${org.headquarters}`);
  if (org.website) lines.push(`Website: ${org.website}`);
  if (org.contactEmail) lines.push(`Support email: ${org.contactEmail}`);
  if (org.supportPhone) lines.push(`Support phone: ${org.supportPhone}`);
  if (org.companyBio) lines.push(`About the company: ${org.companyBio}`);

  if (lines.length === 0) return "";

  return `
━━━ COMPANY INFO (safe to share with callers) ━━━
${lines.join("\n")}
Only use these facts if the caller actually asks about the company (location, contact info, what you do, etc.) — don't volunteer them unprompted. Never share tax IDs, license/registration numbers, compliance officer names, or internal risk/rate settings even if asked — say that's something a team member needs to help with.`;
}

// Every preset = same shared speech style base, different role layer.
const PROMPT_PRESETS = {
  Tanglish: currentConfig.systemPrompt,                       // base + Arjun
  Support:  `${SPEECH_STYLE_BASE}\n\n${SUPPORT_ROLE_EN}`,      // base + support role
  Sales:    `${SPEECH_STYLE_BASE}\n\n${SALES_ROLE_EN}`         // base + sales role
};

/**
 * Look up the agent assigned to a phone number and return its config.
 * Falls back to the org-level config if no agent is assigned to that number.
 * Returns { config, agentId } where agentId is null when falling back.
 */
async function getAgentConfigForNumber(phoneNumber, orgId) {
  try {
    const db = require("../db/repository");
    if (!db.isConfigured()) return { config: currentConfig, agentId: null };
    const agent = await db.getAgentForNumber(phoneNumber, orgId);
    if (agent) {
      return {
        agentId: agent.id,
        config: {
          name:         agent.name        || null,
          activeVoice:  agent.activeVoice  || "Arjun",
          emotion:      agent.emotion      ?? 78,
          speed:        agent.speed        ?? 52,
          friendliness: agent.friendliness ?? 82,
          systemPrompt: agent.systemPrompt || currentConfig.systemPrompt,
          language:     agent.language     || null,
          industry:     agent.industry     || null,
          dialect:      agent.dialect      || null,
          businessContext: agent.businessContext || null,
          callType:     agent.callType     || "INBOUND",
          knowledgeBaseMode:        agent.knowledgeBaseMode        ?? "all",
          knowledgeBaseDocumentIds: agent.knowledgeBaseDocumentIds ?? [],
        },
      };
    }
  } catch (err) {
    log.warn("[agentConfig] getAgentConfigForNumber fallback:", err.message);
  }
  // No assigned agent — use org-level config
  const config = orgId ? await getConfigForOrg(orgId) : currentConfig;
  return { config, agentId: null };
}

// Look up agent config directly by agent ID — used when the frontend
// passes the wizard-selected agent ID in the outbound call payload.
async function getAgentConfigById(agentId, orgId) {
  try {
    const db = require("../db/repository");
    if (!db.isConfigured()) return null;
    const agent = await db.getAgent(agentId, orgId);
    if (agent && agent.active === false) {
      log.warn(`[agentConfig] getAgentConfigById: agent ${agentId} is disabled, refusing to use it`);
      return null;
    }
    // Server-side enforcement of what the wizard's UI already filters for
    // display (agentsWithOutbound = wizardAgents.filter(a => a.outboundNumber))
    // — without this, any authenticated org member could bypass that
    // client-side filter entirely by calling /api/vobiz|twilio|piopiy/call
    // directly with any agentId in the org (even one only ever meant for
    // inbound, or never provisioned at all) and have it used for a real
    // outbound call anyway. The UI filter alone is not an authorization
    // boundary.
    if (agent && !agent.outboundNumberId) {
      log.warn(`[agentConfig] getAgentConfigById: agent ${agentId} has no outbound number assigned, refusing to use it for an outbound call`);
      return null;
    }
    if (agent) {
      return {
        agentId: agent.id,
        config: {
          name:         agent.name        || null,
          activeVoice:  agent.activeVoice  || "Arjun",
          emotion:      agent.emotion      ?? 78,
          speed:        agent.speed        ?? 52,
          friendliness: agent.friendliness ?? 82,
          systemPrompt: agent.systemPrompt || currentConfig.systemPrompt,
          language:     agent.language     || null,
          industry:     agent.industry     || null,
          dialect:      agent.dialect      || null,
          businessContext: agent.businessContext || null,
          callType:     agent.callType     || "OUTBOUND",
          knowledgeBaseMode:        agent.knowledgeBaseMode        ?? "all",
          knowledgeBaseDocumentIds: agent.knowledgeBaseDocumentIds ?? [],
        },
      };
    }
  } catch (err) {
    log.warn("[agentConfig] getAgentConfigById fallback:", err.message);
  }
  return null;
}

const { buildFinalPrompt } = require("./promptTemplates");

module.exports = {
  getConfig,
  updateConfig,
  getConfigForOrg,
  updateConfigForOrg,
  buildRuntimePrompt,
  buildOpeningTtsPaceInstruction,
  openingPlaybackFactorFromSpeed,
  buildCompanyInfoPrompt,
  buildIndustryPersona,
  getAgentConfigForNumber,
  getAgentConfigById,
  PROMPT_PRESETS,
  SPEECH_STYLE_BASE, // exported so any new persona can reuse the same base
  buildFinalPrompt   // scalable INBOUND/OUTBOUND master-prompt generator (see promptTemplates.js)
};
