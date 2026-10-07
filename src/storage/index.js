// src/storage/index.js — high-level object storage operations
//
// Plug-and-play over any S3-compatible backend. Provider is selected by
// STORAGE_PROVIDER (minio | s3 | r2). See src/storage/client.js for the
// full configuration reference.

const { PutObjectCommand, DeleteObjectCommand, GetObjectCommand, CreateBucketCommand, HeadBucketCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { getClient } = require("./client");
const { getScope } = require("../workspaces/scope");
const { getLogger } = require("../observability/logger");
const log = getLogger("storage.index");

const BUCKET = () => {
  if (!process.env.STORAGE_BUCKET) throw new Error("[storage] STORAGE_BUCKET is required.");
  return process.env.STORAGE_BUCKET;
};

// Build the public URL for a stored object.
//
//   STORAGE_PUBLIC_URL set  → <base>/<key>              (all providers)
//   STORAGE_PROVIDER=s3     → if STORAGE_PUBLIC_URL is set, use that; otherwise use the configured S3 endpoint/path style
//   STORAGE_PROVIDER=minio  → <STORAGE_ENDPOINT>/<bucket>/<key>
//   STORAGE_PROVIDER=r2     → <STORAGE_ENDPOINT>/<bucket>/<key>
//
// To serve recordings publicly on MinIO, set the bucket policy to public-read
// and point STORAGE_PUBLIC_URL at the external MinIO URL + bucket path.
// On AWS S3, leave STORAGE_PUBLIC_URL unset — the URL is auto-built.
function publicUrl(key) {
  const base = process.env.STORAGE_PUBLIC_URL;
  if (base) return `${base.replace(/\/$/, "")}/${key}`;

  const provider = (process.env.STORAGE_PROVIDER || "minio").toLowerCase();
  const bucket   = BUCKET();

  if (provider === "s3" && process.env.STORAGE_ENDPOINT) {
    return `${process.env.STORAGE_ENDPOINT.replace(/\/$/, "")}/${bucket}/${key}`;
  }

  if (provider === "s3") {
    const region = process.env.STORAGE_REGION || "us-east-1";
    return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  }

  // MinIO / R2 / generic path-style
  const endpoint = process.env.STORAGE_ENDPOINT || "";
  return `${endpoint.replace(/\/$/, "")}/${bucket}/${key}`;
}

// Self-healing bucket creation — MinIO (and a fresh R2/S3 bucket you forgot
// to provision) start with zero buckets, so the very first upload otherwise
// fails with "The specified bucket does not exist" until someone creates it
// by hand. Checked once per process lifetime, not on every upload.
//
// NOTE: this only creates the bucket — it does NOT set a public-read policy
// (MinIO/R2 don't support per-object ACLs, only bucket-level policies, and
// there's no cross-provider SDK call for that). docker-compose's minio-init
// job is the primary path and also runs `mc anonymous set download`, which
// this fallback can't replicate — if this fallback is what actually creates
// the bucket (minio-init didn't run), playback links may need the bucket
// policy set by hand: `mc anonymous set download local/<bucket>`.
let _bucketEnsured = false;
async function ensureBucket() {
  if (_bucketEnsured) return;
  const client = getClient();
  const bucket = BUCKET();
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    const status = err.$metadata?.httpStatusCode;
    if (status === 404 || err.name === "NotFound" || err.name === "NoSuchBucket") {
      log.warn(`⚠️  [storage] Bucket "${bucket}" doesn't exist — creating it now.`);
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } else {
      // Some providers (e.g. R2 with scoped tokens) reject HeadBucket with a
      // 403 even though the bucket exists and PutObject would work fine —
      // don't block the upload on an inconclusive check.
      log.warn(`⚠️  [storage] HeadBucket check inconclusive for "${bucket}" (${err.name || status}) — proceeding with upload anyway.`);
    }
  }
  _bucketEnsured = true;
}

// STORAGE_USE_SIGNED_URLS=true switches recordings from "public bucket +
// permanent public URL" to "private bucket + short-lived pre-signed URL,
// re-generated on every read." Default false — existing deployments that
// already set a public-read bucket policy (see publicUrl()'s comment)
// keep working exactly as before with zero config change. Turn this on
// instead of setting a bucket policy when you want recordings to stay
// private (no policy needed at all) — e.g. a fresh AWS S3 bucket with
// "Block Public Access" left on, which is the default and the safer
// choice for anything containing real call audio.
const SIGNED_URL_TTL_SECONDS = Number(process.env.STORAGE_SIGNED_URL_TTL_SECONDS) || 3600;
function useSignedUrls() {
  if (process.env.STORAGE_USE_SIGNED_URLS === "true") return true;
  if (process.env.STORAGE_USE_SIGNED_URLS === "false") return false;
  return process.env.NODE_ENV === "production";
}

// Upload a Buffer or Readable stream. Returns what should be stored as
// this object's "url" — a real public URL in the default (public-bucket)
// mode, or just the bare object key in signed-URL mode (there is no
// permanent public URL to hand back; resolvePlaybackUrl() below turns
// the key into a real, time-limited link whenever it's actually served).
//
// ACL is intentionally omitted — MinIO and R2 do not support per-object ACLs
// (they use bucket policies for public access), and AWS S3 buckets with
// "Block Public ACLs" enabled reject ACL headers outright. Public access is
// controlled at the bucket level for all providers.
async function upload(key, body, { contentType = "application/octet-stream" } = {}) {
  await ensureBucket();
  const cmd = new PutObjectCommand({
    Bucket: BUCKET(),
    Key: key,
    Body: body,
    ContentType: contentType,
  });
  await getClient().send(cmd);
  return useSignedUrls() ? key : publicUrl(key);
}

// Generate a pre-signed URL for private objects (expires in `expiresIn` seconds).
// Use this when the bucket is private and you need a time-limited playback link.
async function signedUrl(key, expiresIn = SIGNED_URL_TTL_SECONDS) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET(), Key: key });
  return getSignedUrl(getClient(), cmd, { expiresIn });
}

// Recording object keys encode their owning workspace. Never turn a key read
// from a database row into a signed URL unless it belongs to the active
// workspace. Legacy/default-workspace recordings remain at recordings/<file>.
function recordingKeyBelongsToActiveWorkspace(key) {
  const scope = getScope();
  if (!scope || typeof key !== "string") return false;
  let segments;
  try { segments = key.split("/").map(segment => decodeURIComponent(segment)); }
  catch { return false; }
  if (segments.some(segment => !segment || segment === "." || segment === "..")) return false;
  if (scope.workspaceId === scope.orgId) {
    return segments.length === 2 && segments[0] === "recordings";
  }
  return segments.length === 4 && segments[0] === "recordings" &&
    segments[1] === scope.orgId && segments[2] === scope.workspaceId;
}

// Turns whatever's stored in a recording-url-style column into something
// actually playable right now. A full http(s) URL (the default mode's
// upload() return value, or any historical row saved before signed mode
// was turned on) is already playable and passed through unchanged; a
// bare object key (signed mode's upload() return value) gets resolved
// into a fresh signed URL, generated at read time rather than baked in
// forever — so it can't ever be served stale/expired, and turning signed
// mode on/off doesn't require touching already-stored rows either way.
// Safe to call unconditionally on any recording url value, in either mode.
function objectKeyFromStoredValue(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!/^https?:\/\//i.test(raw)) return raw.replace(/^\/+/, "");

  try {
    const url = new URL(raw);
    const bucket = BUCKET();
    const pathname = decodeURIComponent(url.pathname || "").replace(/^\/+/, "");

    const publicBase = process.env.STORAGE_PUBLIC_URL;
    if (publicBase) {
      const base = new URL(publicBase);
      const basePath = base.pathname.replace(/^\/+|\/+$/g, "");
      if (url.origin === base.origin && (!basePath || pathname.startsWith(basePath + "/"))) {
        return basePath ? pathname.slice(basePath.length + 1) : pathname;
      }
    }

    if (
      url.hostname === bucket + ".s3.amazonaws.com" ||
      url.hostname.startsWith(bucket + ".s3.") ||
      url.hostname === bucket + ".s3.dualstack.amazonaws.com"
    ) {
      return pathname;
    }

    const endpoint = process.env.STORAGE_ENDPOINT;
    if (endpoint) {
      const endpointUrl = new URL(endpoint);
      if (url.origin === endpointUrl.origin) {
        const prefix = bucket + "/";
        return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
      }
    }

    if (url.searchParams.has("X-Amz-Signature") && pathname) {
      return pathname.startsWith(bucket + "/") ? pathname.slice(bucket.length + 1) : pathname;
    }
  } catch (err) {
    log.warn("⚠️ [storage] Could not parse stored playback URL: " + err.message);
  }

  return null;
}

async function resolvePlaybackUrl(value, expiresIn = SIGNED_URL_TTL_SECONDS) {
  if (!value) return value;
  const raw = String(value);
  const key = objectKeyFromStoredValue(value);

  // External provider URLs that are not one of our S3-compatible objects
  // remain untouched. Known storage URLs are always refreshed in production.
  if (!key) return /^https?:\/\//i.test(raw) ? raw : null;
  if (!recordingKeyBelongsToActiveWorkspace(key)) return null;

  try {
    if (/^https?:\/\//i.test(raw) && !useSignedUrls()) return raw;
    return await signedUrl(key, expiresIn);
  } catch (err) {
    log.error("❌ [storage] Failed to sign playback URL for key \"" + key + "\":", err.message);
    return null;
  }
}

// Delete an object by key.
async function remove(key) {
  const cmd = new DeleteObjectCommand({ Bucket: BUCKET(), Key: key });
  await getClient().send(cmd);
}

// Returns true when all required env vars are present.
function isConfigured() {
  return !!(
    process.env.STORAGE_ACCESS_KEY &&
    process.env.STORAGE_SECRET_KEY &&
    process.env.STORAGE_BUCKET
  );
}

module.exports = { upload, signedUrl, resolvePlaybackUrl, remove, publicUrl, isConfigured };
