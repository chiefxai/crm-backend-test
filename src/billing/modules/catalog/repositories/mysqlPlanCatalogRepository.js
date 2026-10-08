'use strict';

const { normalizePlanTerms } = require('../terms');

function resultOf(value) { return Array.isArray(value) && value.length === 2 && Array.isArray(value[0]) ? value[0] : value; }
function rowsOf(value) { const result = resultOf(value); return Array.isArray(result) ? result : result?.rows || []; }
function affectedRows(value) { const result = resultOf(value); return Number(result?.affectedRows ?? result?.rowCount ?? 0); }
function duplicateKey(error) { return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062 || error?.code === '23505'; }
function storageError(message, cause) {
  const error = new Error(message, { cause });
  error.name = 'PlanCatalogStorageError';
  error.code = 'BILLING_CATALOG_STORAGE';
  return error;
}
function fromDb(row) {
  if (!row) return null;
  return {
    id: row.id,
    planId: row.plan_id,
    version: Number(row.version),
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    publishedAt: row.published_at,
    terms: typeof row.terms_json === 'string' ? JSON.parse(row.terms_json) : row.terms_json,
  };
}

/** MySQL repository over the additive billing_plans/billing_plan_versions schema. */
function createMysqlPlanCatalogRepository({ pool }) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('MySQL plan catalog requires pool.connect().');

  async function withTransaction(work) {
    const connection = await pool.connect();
    let started = false;
    try {
      await connection.query('START TRANSACTION');
      started = true;
      const result = await work(connection);
      await connection.query('COMMIT');
      started = false;
      return result;
    } catch (error) {
      if (started) { try { await connection.query('ROLLBACK'); } catch (_) { /* keep original failure */ } }
      if (duplicateKey(error)) throw storageError('Plan code or version already exists.', error);
      throw error;
    } finally { connection.release(); }
  }

  async function createPlanWithDraft({ plan, version }) {
    const terms = normalizePlanTerms(version.terms);
    return withTransaction(async (connection) => {
      await connection.query(
        `INSERT INTO billing_plans (id,code,display_name,status,created_at,updated_at) VALUES (?,?,?,'draft',?,?)`,
        [plan.id, plan.code, plan.displayName, plan.now, plan.now],
      );
      await insertVersion(connection, { ...version, terms });
      return { plan: { ...plan, status: 'draft' }, version: versionResult(version, terms) };
    });
  }

  async function createDraftVersion({ planId, id, terms, now }) {
    terms = normalizePlanTerms(terms);
    return withTransaction(async (connection) => {
      const plans = rowsOf(await connection.query('SELECT id FROM billing_plans WHERE id=? FOR UPDATE', [planId]));
      if (!plans[0]) return null;
      const result = rowsOf(await connection.query('SELECT COALESCE(MAX(version),0) AS max_version FROM billing_plan_versions WHERE plan_id=?', [planId]));
      const version = Number(result[0]?.max_version || 0) + 1;
      const record = { id, planId, version, terms, now };
      await insertVersion(connection, record);
      return versionResult(record, terms);
    });
  }

  async function replaceDraftTerms({ planId, version, terms, now }) {
    terms = normalizePlanTerms(terms);
    const changed = await withTransaction(async (connection) => {
      const rows = rowsOf(await connection.query(
        `SELECT id,status FROM billing_plan_versions WHERE plan_id=? AND version=? FOR UPDATE`, [planId, version],
      ));
      if (!rows[0]) return { missing: true };
      if (rows[0].status !== 'draft') return { conflict: true };
      const result = await connection.query(
        `UPDATE billing_plan_versions
            SET terms_json=?,price_units=?,price_asset=?,price_scale=?,included_credit_units=?,credit_asset=?,credit_scale=?,currency=?,updated_at=?
          WHERE plan_id=? AND version=? AND status='draft'`,
        [JSON.stringify(terms), terms.subscriptionPrice.units, terms.subscriptionPrice.asset, terms.subscriptionPrice.scale,
          terms.includedCredits.units, terms.includedCredits.asset, terms.includedCredits.scale, terms.currency, now, planId, version],
      );
      if (affectedRows(result) !== 1) throw storageError('Draft plan version changed concurrently.');
      return { id: rows[0].id };
    });
    if (changed.missing || changed.conflict) return null;
    return getVersion({ planId, version });
  }

  async function publishDraft({ planId, version, effectiveAt, now }) {
    return withTransaction(async (connection) => {
      const planRows = rowsOf(await connection.query('SELECT id FROM billing_plans WHERE id=? FOR UPDATE', [planId]));
      if (!planRows[0]) return null;
      const targetRows = rowsOf(await connection.query(
        `SELECT id,status FROM billing_plan_versions WHERE plan_id=? AND version=? FOR UPDATE`, [planId, version],
      ));
      if (!targetRows[0]) return null;
      if (targetRows[0].status !== 'draft') return { conflict: true, reason: 'version_not_draft' };
      const later = rowsOf(await connection.query(
        `SELECT id FROM billing_plan_versions WHERE plan_id=? AND status='published' AND effective_from>=? FOR UPDATE`,
        [planId, effectiveAt],
      ));
      if (later.length) return { conflict: true, reason: 'later_effective_version_exists' };
      const current = rowsOf(await connection.query(
        `SELECT id FROM billing_plan_versions
          WHERE plan_id=? AND status='published' AND effective_from<?
            AND (effective_to IS NULL OR effective_to>?) FOR UPDATE`,
        [planId, effectiveAt, effectiveAt],
      ));
      if (current.length > 1) throw storageError('Overlapping published plan versions already exist.');
      if (current[0]) {
        const closed = await connection.query(
          `UPDATE billing_plan_versions SET effective_to=?,updated_at=? WHERE id=? AND status='published' AND (effective_to IS NULL OR effective_to>?)`,
          [effectiveAt, now, current[0].id, effectiveAt],
        );
        if (affectedRows(closed) !== 1) throw storageError('Current published version could not be closed at the new effective boundary.');
      }
      const published = await connection.query(
        `UPDATE billing_plan_versions SET status='published',effective_from=?,effective_to=NULL,published_at=?,updated_at=? WHERE id=? AND status='draft'`,
        [effectiveAt, now, now, targetRows[0].id],
      );
      if (affectedRows(published) !== 1) throw storageError('Draft version changed before publication.');
      await connection.query(`UPDATE billing_plans SET status='active',updated_at=? WHERE id=?`, [now, planId]);
      return fromDb(rowsOf(await connection.query(
        `SELECT id,plan_id,version,status,terms_json,effective_from,effective_to,published_at FROM billing_plan_versions WHERE id=?`,
        [targetRows[0].id],
      ))[0]);
    });
  }

  async function getVersion({ planId, version }) {
    const connection = await pool.connect();
    try {
      return fromDb(rowsOf(await connection.query(
        `SELECT id,plan_id,version,status,terms_json,effective_from,effective_to,published_at FROM billing_plan_versions WHERE plan_id=? AND version=? LIMIT 1`,
        [planId, version],
      ))[0]);
    } finally { connection.release(); }
  }

  async function getEffectiveVersion({ planId, at }) {
    const connection = await pool.connect();
    try {
      const rows = rowsOf(await connection.query(
        `SELECT id,plan_id,version,status,terms_json,effective_from,effective_to,published_at
           FROM billing_plan_versions WHERE plan_id=? AND status='published' AND effective_from<=?
             AND (effective_to IS NULL OR effective_to>?) ORDER BY effective_from DESC,version DESC LIMIT 2`,
        [planId, at, at],
      ));
      if (rows.length > 1) throw storageError('Overlapping published plan versions detected.');
      return fromDb(rows[0]);
    } finally { connection.release(); }
  }

  async function listPlans({ status, limit = 100, afterId } = {}) {
    const connection = await pool.connect();
    try {
      const filters = [];
      const params = [];
      if (status) { filters.push('status=?'); params.push(status); }
      if (afterId) { filters.push('id>?'); params.push(afterId); }
      params.push(limit);
      const rows = rowsOf(await connection.query(
        `SELECT id,code,display_name,status,created_at,updated_at FROM billing_plans
          ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY id LIMIT ?`, params,
      ));
      return rows.map((row) => ({ id: row.id, code: row.code, displayName: row.display_name, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }));
    } finally { connection.release(); }
  }

  async function listVersions({ planId, limit = 100, afterVersion } = {}) {
    const connection = await pool.connect();
    try {
      const cursorClause = afterVersion === undefined ? '' : ' AND version<?';
      const params = afterVersion === undefined ? [planId, limit] : [planId, afterVersion, limit];
      const rows = rowsOf(await connection.query(
        `SELECT id,plan_id,version,status,terms_json,effective_from,effective_to,published_at
           FROM billing_plan_versions WHERE plan_id=?${cursorClause} ORDER BY version DESC LIMIT ?`, params,
      ));
      return rows.map(fromDb);
    } finally { connection.release(); }
  }

  async function insertVersion(connection, record) {
    const terms = record.terms;
    await connection.query(
      `INSERT INTO billing_plan_versions
         (id,plan_id,version,status,terms_json,price_units,price_asset,price_scale,included_credit_units,credit_asset,credit_scale,currency,
          billing_interval_unit,billing_interval_count,effective_from,effective_to,published_at,created_at,updated_at)
       VALUES (?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?)`,
      [record.id, record.planId, record.version, JSON.stringify(terms), terms.subscriptionPrice.units, terms.subscriptionPrice.asset,
        terms.subscriptionPrice.scale, terms.includedCredits.units, terms.includedCredits.asset, terms.includedCredits.scale,
        terms.currency, terms.billingInterval.unit, terms.billingInterval.count, record.now, record.now],
    );
  }

  return Object.freeze({ createPlanWithDraft, createDraftVersion, replaceDraftTerms, publishDraft, getVersion, getEffectiveVersion, listPlans, listVersions });
}

function versionResult(record, terms) {
  return { id: record.id, planId: record.planId, version: record.version, status: 'draft', effectiveFrom: null, effectiveTo: null, publishedAt: null, terms };
}

module.exports = { createMysqlPlanCatalogRepository, storageError };
