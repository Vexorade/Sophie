'use strict';
const crypto = require('crypto');

// Manifiesto oficial de Mercado Pago: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
function verifySignature(secret, dataId, requestId, signature) {
  if (!secret || !/^\d+$/.test(dataId || '') || !requestId || requestId.length > 200) return false;
  const parts = Object.fromEntries(String(signature || '').split(',').map((p) => p.trim().split('=')));
  if (!/^\d+$/.test(parts.ts || '') || !/^[a-f0-9]{64}$/i.test(parts.v1 || '')) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest();
  const received = Buffer.from(parts.v1, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

module.exports = { verifySignature };
