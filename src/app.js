// src/app.js — Express factory: middleware + route mounting

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");
const { getLogger } = require("./observability/logger");
const app = express();

const httpLog = getLogger("http");

// Trust Caddy reverse proxy (needed for correct IP + protocol)
app.set("trust proxy", 1);

// ── Request correlation (OpenTelemetry-style log id) ───────────────────────────
// Every request gets a logId — reused from an incoming X-Request-Id if the
// proxy/client already set one, otherwise generated here. It's echoed back
// as a response header and attached to req.log so every downstream handler
// can log with the same correlation id, and to req.logId for anything that
// wants the raw value (e.g. to fold into an error response body).
app.use((req, res, next) => {
  const logId = req.headers["x-request-id"] || crypto.randomUUID();
  req.logId = logId;
  req.log = httpLog.child({ logId, method: req.method, path: req.path });
  res.setHeader("X-Request-Id", logId);

  const startedAt = Date.now();
  res.on("finish", () => {
    req.log.info("HTTP request", {
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      orgId: req.orgId,
      workspaceId: req.workspaceId,
    });
  });

  next();
});

// ── Security headers (CSP relaxed for Swagger UI + SSE) ───────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Caddy sets CSP; Swagger UI needs inline scripts
  crossOriginEmbedderPolicy: false,
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: ALLOWED_ORIGINS.length
    ? (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin) ? cb(null, true) : cb(new Error("CORS")))
    : true, // dev: allow all
  credentials: true,
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 300, // ~18 sync calls on load × multiple tabs + headroom
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  skip: (req) => req.path === "/health",
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // login/logout only — not data sync
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth requests, please try again later." },
});

app.use("/api/", apiLimiter);
app.use("/api/auth/", authLimiter);

// 10mb covers full call transcripts in sync payloads (default 100kb was too small)
app.use(express.json({ limit: "10mb", verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: true }));
app.use("/public", express.static(path.join(__dirname, "../public")));


app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/ready", async (req, res) => {
  try {
    const db = require("./db/repository");
    const { getQueueHealth } = require("./queue");
    await db.supabase.ready;
    const queue = getQueueHealth();
    if (!queue.ready) return res.status(503).json({ ok: false, ready: false, dependencies: { database: true, queue: false } });
    return res.json({ ok: true, ready: true, dependencies: { database: true, queue: true } });
  } catch (err) {
    req.log.error("Readiness check failed", err);
    return res.status(503).json({ ok: false, ready: false });
  }
});

// Swagger UI + OpenAPI spec — available at /docs
require("./docs/swagger").mountSwagger(app);

// All API routes
app.use("/", require("./routes/index"));
app.use("/", require("./routes/scheduler"));

module.exports = app;
