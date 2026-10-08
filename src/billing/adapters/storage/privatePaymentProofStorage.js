'use strict';

const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

function safeSegment(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function createS3PrivatePaymentProofStorage({ client, bucket, signUrl, maxTtlSeconds = 300 } = {}) {
  if (!client || typeof client.send !== 'function') throw new TypeError('Private payment proof storage requires an S3-compatible client.');
  if (typeof bucket !== 'string' || !bucket.trim()) throw new TypeError('Private payment proof storage requires a bucket.');
  if (typeof signUrl !== 'function') throw new TypeError('Private payment proof storage requires a presigned URL function.');

  function keyFor({ orgId, paymentRequestId, sha256 }) {
    safeSegment(orgId, 'orgId');
    safeSegment(paymentRequestId, 'paymentRequestId');
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError('sha256 is invalid.');
    return `billing/payment-proofs/${orgId}/${paymentRequestId}/${sha256}`;
  }

  return Object.freeze({
    async put({ orgId, paymentRequestId, proof }) {
      const key = keyFor({ orgId, paymentRequestId, sha256: proof?.sha256 });
      if (!Buffer.isBuffer(proof?.buffer) || !proof.contentType) throw new TypeError('Validated payment proof is required.');
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: proof.buffer, ContentLength: proof.buffer.length,
        ContentType: proof.contentType,
        Metadata: { sha256: proof.sha256, orgid: orgId, paymentrequestid: paymentRequestId },
      }));
      return key;
    },
    async signedDownload({ key, expiresIn = 120 }) {
      if (typeof key !== 'string' || !/^billing\/payment-proofs\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[a-f0-9]{64}$/.test(key)) {
        throw new TypeError('Payment proof object key is invalid.');
      }
      if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > maxTtlSeconds) throw new TypeError(`expiresIn must be from 1 to ${maxTtlSeconds} seconds.`);
      return signUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
    },
    async remove({ key }) {
      if (typeof key !== 'string' || !/^billing\/payment-proofs\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[a-f0-9]{64}$/.test(key)) {
        throw new TypeError('Payment proof object key is invalid.');
      }
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  });
}

function createConfiguredPrivatePaymentProofStorage() {
  const { getClient } = require('../../../storage/client');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  if (!process.env.STORAGE_BUCKET) throw new Error('STORAGE_BUCKET is required for private payment proofs.');
  return createS3PrivatePaymentProofStorage({
    client: getClient(), bucket: process.env.STORAGE_BUCKET,
    signUrl: getSignedUrl,
  });
}

module.exports = { createS3PrivatePaymentProofStorage, createConfiguredPrivatePaymentProofStorage };
