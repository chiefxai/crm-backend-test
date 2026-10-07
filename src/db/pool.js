// Shared MySQL pool. All DB consumers use this single pool.
const mysql = require("mysql2/promise");

/**
 * Convert PostgreSQL-style numbered placeholders ($1, $2, ...) and native
 * MySQL placeholders (?) into one MySQL-compatible parameter list.
 *
 * A few legacy repository queries intentionally mix the two forms while the
 * migration is being completed. We resolve placeholders in their actual SQL
 * order, while respecting quoted strings/backticks so JSON paths and text
 * containing '$1' are not modified.
 */
function normalizeSql(sql, params = []) {
  const text = String(sql);
  const values = Array.isArray(params) ? params : [];
  const out = [];
  const consumed = new Set();
  let result = "";
  let i = 0;
  let quote = null;

  while (i < text.length) {
    const ch = text[i];

    if (quote) {
      result += ch;
      if (ch === "\\" && quote !== "`" && i + 1 < text.length) {
        result += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        // SQL escapes a quote by doubling it: '' / "" / ``.
        if (text[i + 1] === quote) {
          result += text[i + 1];
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      result += ch;
      i += 1;
      continue;
    }

    if (ch === "$" && /\d/.test(text[i + 1] || "")) {
      let j = i + 1;
      while (j < text.length && /\d/.test(text[j])) j += 1;
      const index = Number(text.slice(i + 1, j)) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= values.length) {
        throw new Error(`[db/pool] SQL placeholder $${text.slice(i + 1, j)} has no matching parameter`);
      }
      result += "?";
      out.push(values[index]);
      consumed.add(index);
      i = j;
      continue;
    }

    if (ch === "?") {
      // Native '?' consumes the next parameter that has not already been
      // consumed by a numbered placeholder. This keeps mixed legacy queries
      // deterministic, e.g. `$1 ... IN (?, ?)` with [orgId, id1, id2].
      let index = 0;
      while (index < values.length && consumed.has(index)) index += 1;
      if (index >= values.length) {
        throw new Error("[db/pool] SQL placeholder ? has no matching parameter");
      }
      result += "?";
      out.push(values[index]);
      consumed.add(index);
      i += 1;
      continue;
    }

    result += ch;
    i += 1;
  }

  if (consumed.size !== values.length) {
    throw new Error(`[db/pool] SQL parameter count mismatch: SQL consumes ${consumed.size} distinct parameters, received ${values.length}`);
  }
  return { sql: result, params: out };
}

const { getLogger } = require("../observability/logger");
const log = getLogger("db.pool");

function getMysqlConfig() {
  const connectionString = String(process.env.MYSQL_URL || "").trim();
  if (connectionString) {
    const parsed = new URL(connectionString);
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    if (!parsed.hostname || !database) throw new Error("[db/pool] MYSQL_URL must include host and database");
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 3306,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database,
      ssl: parsed.searchParams.get("ssl") === "true" ? {} : undefined,
    };
  }

  const host = String(process.env.MYSQL_HOST || "").trim();
  const database = String(process.env.MYSQL_DATABASE || "").trim();
  const user = String(process.env.MYSQL_USER || "").trim();
  if (!host || !database || !user) {
    throw new Error("[db/pool] Configure MYSQL_URL or MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, and MYSQL_DATABASE");
  }
  return {
    host,
    port: Number(process.env.MYSQL_PORT || 3306),
    user,
    password: process.env.MYSQL_PASSWORD || "",
    database,
    ssl: String(process.env.MYSQL_SSL || "false").toLowerCase() === "true" ? {} : undefined,
  };
}

const mysqlConfig = getMysqlConfig();
const pool = mysql.createPool({
  ...mysqlConfig,
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_POOL_MAX || 10),
  idleTimeout: Number(process.env.MYSQL_POOL_IDLE_TIMEOUT_MS || 10000),
  connectTimeout: Number(process.env.MYSQL_POOL_CONNECTION_TIMEOUT_MS || 10000),
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  // Bound requests waiting for a pooled connection. The mysql2 default is
  // queueLimit=0 (unbounded), which can turn DB saturation into unbounded
  // memory/request growth. Fail fast once the queue is full.
  queueLimit: Number(process.env.MYSQL_POOL_QUEUE_LIMIT || 50),
});

// Surface pool-level failures without allowing an emitted error to become an
// unhandled EventEmitter exception. Individual query/connection failures are
// still propagated to their callers.
if (typeof pool.on === "function") {
  pool.on("error", (err) => {
    log.error("MySQL pool error", err);
  });
}

function wrapConnection(connection) {
  return {
    async query(sql, params = []) {
      const q = normalizeSql(sql, params);
      const [rows, fields] = await connection.query(q.sql, q.params);
      return {
        rows: Array.isArray(rows) ? rows : [],
        fields,
        rowCount: Array.isArray(rows) ? rows.length : Number(rows?.affectedRows || 0),
        affectedRows: Array.isArray(rows) ? rows.length : Number(rows?.affectedRows || 0),
        insertId: Array.isArray(rows) ? undefined : rows?.insertId,
      };
    },
    release() { connection.release(); },
  };
}

const wrappedPool = {
  async query(sql, params = []) {
    const q = normalizeSql(sql, params);
    const [rows, fields] = await pool.query(q.sql, q.params);
    return {
      rows: Array.isArray(rows) ? rows : [],
      fields,
      rowCount: Array.isArray(rows) ? rows.length : Number(rows?.affectedRows || 0),
      affectedRows: Array.isArray(rows) ? rows.length : Number(rows?.affectedRows || 0),
      insertId: Array.isArray(rows) ? undefined : rows?.insertId,
    };
  },
  async connect() { return wrapConnection(await pool.getConnection()); },
};

let closed = false;
async function closePool() { if (closed) return; closed = true; return pool.end(); }
function getPool() { return wrappedPool; }
module.exports = { pool: wrappedPool, closePool, getPool, normalizeSql };
