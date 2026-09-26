// Which billable services apply to an organization (extensible).
function normalizeChargeScope(value) {
  return value === "ai_and_call_provider" ? "ai_and_call_provider" : "ai_only";
}

function getOrgServiceProfile(org) {
  const scope = normalizeChargeScope(org?.chargeScope);
  const aiEnabled = true;
  const phoneEnabled = scope === "ai_and_call_provider";
  let mode = "ai_only";
  if (phoneEnabled && aiEnabled) mode = "ai_and_phone";
  else if (phoneEnabled) mode = "phone_only";
  return {
    chargeScope: scope,
    aiEnabled,
    phoneEnabled,
    mode,
    labels: {
      ai_only: "AI only",
      ai_and_phone: "AI + Phone",
      phone_only: "Phone only",
    },
  };
}

module.exports = {
  normalizeChargeScope,
  getOrgServiceProfile,
};
