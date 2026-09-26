// ============================================================
// Recharge-based organization billing
// ============================================================
// Opt-in wallet gate for organizations configured with
// billingMethod = "recharge_based". Pay-as-you-go organizations
// bypass this module completely.
//
// The wallet reserves a small estimated amount before an outbound
// call is placed, then settles the reservation against the actual
// call duration after finalization. The reservation is atomic so
// concurrent calls cannot spend the same available balance twice.
// ============================================================

const crypto = require("crypto");
const db = require("../db/repository");
const costProviders = require("../platform/costProviders");
const channelsEngine = require("../channels/engine");

const ENV_RESERVATION_MINUTES = Math.max(1, Number(process.env.RECHARGE_CALL_RESERVATION_MINUTES || 1));

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeBillingMethod(value) {
  return value === "recharge_based" ? "recharge_based" : "pay_as_you_go";
}

function normalizeChargeScope(value) {
  return value === "ai_and_call_provider" ? "ai_and_call_provider" : "ai_only";
}

async function isSelfManagedProvider(orgId, providerKey) {
  if (providerKey !== "vobiz") return false;
  try {
    const channel = await channelsEngine.getChannel(orgId, "vobiz");
    return !!channel && channel.status === "connected";
  } catch {
    return false;
  }
}

async function getReservationMinutes(org) {
  try {
    const { getEffectiveMinimumBalance } = require("../billing/minimumBalance");
    const effective = await getEffectiveMinimumBalance(org);
    return Math.max(1, Number(effective.effectiveReservationMinutes) || ENV_RESERVATION_MINUTES);
  } catch {
    return ENV_RESERVATION_MINUTES;
  }
}

async function estimateReservation(orgId, providerKey) {
  const org = await db.getOrg(orgId);
  if (!org) {
    const err = new Error("Organization not found");
    err.statusCode = 404;
    throw err;
  }

  const method = normalizeBillingMethod(org.billingMethod);
  const scope = normalizeChargeScope(org.chargeScope);
  if (method !== "recharge_based") return { allowed: true, org, billingMethod: method, chargeScope: scope, amount: 0 };

  const reservationMinutes = await getReservationMinutes(org);
  const [ai, call, selfManaged] = await Promise.all([
    costProviders.computeAiCost({ providerKey: "gemini", orgId, totalTokens: 0, durationSeconds: reservationMinutes * 60 }).catch(() => null),
    scope === "ai_and_call_provider" ? costProviders.computeCallCost({ providerKey, seconds: reservationMinutes * 60 }).catch(() => null) : null,
    scope === "ai_and_call_provider" ? isSelfManagedProvider(orgId, providerKey) : false,
  ]);

  let amount = 0;
  if (ai) amount += Number(ai.totalCost) || 0;
  if (scope === "ai_and_call_provider" && !selfManaged && call) amount += Number(call.totalCost) || 0;
  amount = money(amount);

  // If AI pricing is not configured yet, don't block a recharge org just
  // because the platform has not set an AI rate. A non-zero provider rate
  // still protects the wallet when call-provider charging is enabled.
  return { allowed: true, org, billingMethod: method, chargeScope: scope, amount, selfManaged };
}

async function authorizeOutboundCall(orgId, { providerKey = "vobiz" } = {}) {
  const estimate = await estimateReservation(orgId, providerKey);
  if (estimate.billingMethod !== "recharge_based") return null;

  const reservationId = crypto.randomUUID();
  const amount = estimate.amount;
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT recharge_balance_inr, recharge_reserved_inr, billing_method, charge_scope FROM organizations WHERE id = $1 FOR UPDATE",
      [orgId]
    );
    const row = rows[0];
    if (!row) {
      const err = new Error("Organization not found");
      err.statusCode = 404;
      throw err;
    }

    const balance = money(row.recharge_balance_inr);
    const reserved = money(row.recharge_reserved_inr);
    const available = money(balance - reserved);

    const { getEffectiveMinimumBalance } = require("../billing/minimumBalance");
    const orgForMinimum = estimate.org || (await db.getOrg(orgId));
    if (!orgForMinimum) {
      const err = new Error("Organization not found");
      err.statusCode = 404;
      throw err;
    }
    const minimum = await getEffectiveMinimumBalance(orgForMinimum);
    const requiredAvailable = money(Math.max(amount, minimum.effectiveMinimumBalanceInr || 0));

    if (available < requiredAvailable) {
      const err = new Error(
        requiredAvailable > 0
          ? `Insufficient recharge balance. Available ₹${available.toFixed(2)}, need at least ₹${requiredAvailable.toFixed(2)} (reservation + minimum call balance).`
          : "Recharge balance is empty. Please recharge the organization before placing outbound calls."
      );
      // Keep a stable machine-readable reason all the way through the
      // telephony connector and background dialer. Some error wrappers
      // preserve the message but drop statusCode, so auto-dial must not
      // depend on HTTP semantics to recognize a wallet block.
      err.statusCode = 402;
      err.code = "INSUFFICIENT_RECHARGE_BALANCE";
      err.isRechargeBillingError = true;
      throw err;
    }

    await client.query(
      "UPDATE organizations SET recharge_reserved_inr = COALESCE(recharge_reserved_inr, 0) + $1 WHERE id = $2",
      [amount, orgId]
    );

    await client.query(
      "INSERT INTO recharge_billing_reservations (id,org_id,provider,estimated_amount_inr,status,created_at) VALUES ($1,$2,$3,$4,'reserved',$5)",
      [reservationId, orgId, providerKey, amount, new Date().toISOString()]
    );

    await client.query("COMMIT");
    return { id: reservationId, orgId, estimatedAmountInr: amount };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function attachProviderCall(reservationId, providerCallSid) {
  if (!reservationId || !providerCallSid) return;
  await db.supabase.from("recharge_billing_reservations").update({
    provider_call_sid: providerCallSid,
    updated_at: new Date().toISOString()
  }).eq("id", reservationId);
}

async function releaseReservation(reservationId) {
  if (!reservationId) return null;
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT * FROM recharge_billing_reservations WHERE id = $1 FOR UPDATE",
      [reservationId]
    );
    const reservation = rows[0];
    if (!reservation || reservation.status !== "reserved") {
      await client.query("COMMIT");
      return reservation || null;
    }

    const amount = money(reservation.estimated_amount_inr);
    await client.query(
      "UPDATE organizations SET recharge_reserved_inr = GREATEST(0, COALESCE(recharge_reserved_inr, 0) - $1) WHERE id = $2",
      [amount, reservation.org_id]
    );
    await client.query(
      "UPDATE recharge_billing_reservations SET status='released', released_at=$1, updated_at=$1 WHERE id=$2",
      [new Date().toISOString(), reservationId]
    );
    await client.query("COMMIT");
    return reservation;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function settleReservation({ reservationId, durationSeconds = 0, aiCostInr = null }) {
  if (!reservationId) return null;
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT * FROM recharge_billing_reservations WHERE id = $1 FOR UPDATE",
      [reservationId]
    );
    const reservation = rows[0];
    if (!reservation || reservation.status !== "reserved") {
      await client.query("COMMIT");
      return reservation || null;
    }

    const orgResult = await client.query(
      "SELECT * FROM organizations WHERE id = $1 FOR UPDATE",
      [reservation.org_id]
    );
    const org = orgResult.rows[0];
    if (!org) throw new Error("Organization not found while settling recharge reservation");

    const scope = normalizeChargeScope(org.charge_scope);
    const providerKey = reservation.provider || "vobiz";
    const selfManaged = scope === "ai_and_call_provider" && await isSelfManagedProvider(reservation.org_id, providerKey);

    const [aiCost, callCost] = await Promise.all([
      costProviders.computeAiCost({ providerKey: "gemini", orgId: reservation.org_id, totalTokens: 0, durationSeconds: Number(durationSeconds) || 0 }).catch(() => null),
      scope === "ai_and_call_provider" && !selfManaged
        ? costProviders.computeCallCost({ providerKey, seconds: Number(durationSeconds) || 0 }).catch(() => null)
        : null,
    ]);

    let actual = 0;
    if (aiCostInr != null) actual += Number(aiCostInr) || 0;
    else if (aiCost) actual += Number(aiCost.totalCost) || 0;
    if (callCost) actual += Number(callCost.totalCost) || 0;
    actual = money(actual);

    const reserved = money(reservation.estimated_amount_inr);
    const balance = money(org.recharge_balance_inr);
    const newBalance = money(Math.max(0, balance - actual));
    const newReserved = money(Math.max(0, money(org.recharge_reserved_inr) - reserved));

    await client.query(
      "UPDATE organizations SET recharge_balance_inr=$1, recharge_reserved_inr=$2 WHERE id=$3",
      [newBalance, newReserved, reservation.org_id]
    );
    await client.query(
      "UPDATE recharge_billing_reservations SET status='settled', actual_amount_inr=$1, duration_seconds=$2, finalized_at=$3, updated_at=$3 WHERE id=$4",
      [actual, Number(durationSeconds) || 0, new Date().toISOString(), reservationId]
    );
    await client.query("COMMIT");
    try {
      const ledgerService = require("../billing/ledgerService");
      const releaseDelta = money(reserved - actual);
      if (releaseDelta > 0) {
        await ledgerService.appendLedgerEntry(reservation.org_id, {
          type: "reservation_release",
          amountInr: releaseDelta,
          balanceAfterInr: newBalance,
          referenceType: "reservation",
          referenceId: reservationId,
          description: "Unused reservation released after call settlement",
        });
      }
      await ledgerService.appendLedgerEntry(reservation.org_id, {
        type: "actual_spend",
        amountInr: -actual,
        balanceAfterInr: newBalance,
        referenceType: "reservation",
        referenceId: reservationId,
        description: "Call spend settled from reservation",
        metadata: { durationSeconds: Number(durationSeconds) || 0 },
      });
    } catch {}
    return { reservationId, actualAmountInr: actual, balanceInr: newBalance };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function rechargeOrganization(orgId, amount, actor = {}) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Recharge amount must be greater than 0");

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT recharge_balance_inr FROM organizations WHERE id=$1 FOR UPDATE", [orgId]);
    if (!rows[0]) {
      const err = new Error("Organization not found");
      err.statusCode = 404;
      throw err;
    }
    const next = money(Number(rows[0].recharge_balance_inr) + value);
    await client.query("UPDATE organizations SET recharge_balance_inr=$1 WHERE id=$2", [next, orgId]);
    await client.query(
      "INSERT INTO recharge_billing_transactions (id,org_id,type,amount_inr,balance_after_inr,metadata,created_at) VALUES ($1,$2,'recharge',$3,$4,$5,$6)",
      [crypto.randomUUID(), orgId, money(value), next, JSON.stringify({ actorUserId: actor.userId || null, actorEmail: actor.userEmail || null }), new Date().toISOString()]
    );
    await client.query("COMMIT");
    try {
      const ledgerService = require("../billing/ledgerService");
      await ledgerService.appendLedgerEntry(orgId, {
        type: "recharge",
        amountInr: money(value),
        balanceAfterInr: next,
        referenceType: "organization",
        referenceId: orgId,
        description: "Wallet recharge",
        actorUserId: actor.userId || null,
        actorEmail: actor.userEmail || null,
      });
    } catch {}
    return { balanceInr: next };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function getBillingState(orgId) {
  const org = await db.getOrg(orgId);
  if (!org) return null;
  const balance = money(org.rechargeBalanceInr);
  const reserved = money(org.rechargeReservedInr);
  return {
    billingMethod: normalizeBillingMethod(org.billingMethod),
    chargeScope: normalizeChargeScope(org.chargeScope),
    balanceInr: balance,
    reservedInr: reserved,
    availableInr: money(balance - reserved),
  };
}

async function settleReservationForCall({ orgId, providerCallSid, durationSeconds, aiCostInr = null }) {
  if (!orgId || !providerCallSid) return null;
  const { data: rows } = await db.supabase
    .from("recharge_billing_reservations")
    .select("id")
    .eq("org_id", orgId)
    .eq("provider_call_sid", providerCallSid)
    .limit(1);
  const id = rows?.[0]?.id;
  if (!id) return null;
  return settleReservation({ reservationId: id, durationSeconds, aiCostInr });
}

module.exports = {
  authorizeOutboundCall,
  attachProviderCall,
  releaseReservation,
  settleReservation,
  settleReservationForCall,
  rechargeOrganization,
  getBillingState,
  normalizeBillingMethod,
  normalizeChargeScope,
};
