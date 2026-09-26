const { computeCallBillingBreakdown } = require("./callBillingService");

async function previewExampleCall({ org, providerKey = "vobiz", durationSeconds = 600, callId = null }) {
  const breakdown = await computeCallBillingBreakdown({
    org,
    providerKey,
    durationSeconds,
    callId,
  });
  const minutes = (durationSeconds || 0) / 60;
  return {
    durationSeconds,
    durationMinutes: round2(minutes),
    breakdown,
    lines: buildPreviewLines(breakdown, minutes),
    estimatedTotalInr: breakdown.totalCostInr,
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function buildPreviewLines(breakdown, minutes) {
  const lines = [];
  if (breakdown.services.aiEnabled) {
    if (breakdown.pricingMode === "TOKEN_BASED") {
      lines.push({ label: "AI (token-based)", detail: "Uses finalized session token costs", amountInr: breakdown.aiCostInr });
    } else {
      lines.push({
        label: "Voice / Audio Agent",
        detail: `${round2(minutes)} min (from session finalize)`,
        amountInr: breakdown.voiceAgentCostInr,
      });
      lines.push({
        label: "Post-call Agent",
        detail: "Per post-call session finalize",
        amountInr: breakdown.postCallAgentCostInr,
      });
    }
  }
  if (breakdown.services.phoneEnabled && breakdown.providerCostDetail) {
    lines.push({
      label: `Provider (${breakdown.telephonyProvider})`,
      detail: `${round2(minutes)} min × ₹${breakdown.providerRateAmount}/${breakdown.providerRateUnit}`,
      amountInr: breakdown.providerCostInr,
    });
  }
  return lines;
}

module.exports = {
  previewExampleCall,
};
