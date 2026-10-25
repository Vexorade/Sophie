'use strict';
const config = require('./config');

const API = 'https://api.mercadopago.com';

class MpError extends Error {}

async function call(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: { Authorization: 'Bearer ' + config.mpToken, 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new MpError('Mercado Pago no pudo completar la operación.');
  return res.json();
}

// Evita cobrar con credenciales de otro ambiente (prueba vs. real).
async function sellerId() {
  const s = await call('/users/me');
  const isTest = Array.isArray(s.tags) && s.tags.includes('test_user');
  if (config.live === isTest) throw new MpError('Las credenciales no corresponden al ambiente de pago configurado.');
  return s.id;
}

const paymentTypes = () => call('/v1/payment_types');
const createPreference = (body) => call('/checkout/preferences', { method: 'POST', body: JSON.stringify(body) });
const getPayment = (id) => call('/v1/payments/' + encodeURIComponent(id));
const searchPayments = (ref) =>
  call('/v1/payments/search?external_reference=' + encodeURIComponent(ref) + '&sort=date_created&criteria=desc&limit=100');

function checkoutUrl(pref) {
  const url = config.live ? pref.init_point : pref.sandbox_init_point;
  try {
    const u = new URL(url);
    const ok = u.protocol === 'https:' && /(^|\.)mercadopago\.com(\.ar)?$/.test(u.hostname);
    return ok ? u.href : null;
  } catch {
    return null;
  }
}

module.exports = { sellerId, paymentTypes, createPreference, getPayment, searchPayments, checkoutUrl, MpError };
