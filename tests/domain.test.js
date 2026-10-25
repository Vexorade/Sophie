'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('../lib/pricing');
const { verifySignature } = require('../lib/webhook-signature');
const crypto = require('crypto');

const base = { model: 0, fabric: 'shot', color: 0, side: 'left', legs: 'wood' };

test('contado: seña del 50% sobre precio de lista', () => {
  const q = pricing.quote({ ...base, payment: 'Transferencia' });
  assert.equal(q.total, 73589000);
  assert.equal(q.due, 36794500);
  assert.equal(q.balance, 36794500);
});

test('Pana Best suma 5%', () => {
  const q = pricing.quote({ ...base, fabric: 'best', color: 0, payment: 'Mercado Pago' });
  assert.equal(q.total, Math.round(73589000 * 1.05));
});

test('crédito cobra el total de lista íntegro', () => {
  const q = pricing.quote({ ...base, payment: 'Tarjeta de crédito' });
  assert.equal(q.due, q.total);
  assert.equal(q.type, 'credit_card');
});

test('modelo pendiente (Luxury) no se vende', () => {
  assert.throws(() => pricing.quote({ ...base, model: 4, payment: 'Transferencia' }));
});

test('color fuera de rango se rechaza según la tela', () => {
  assert.throws(() => pricing.quote({ ...base, color: 15, fabric: 'best', payment: 'Transferencia' }));
  assert.doesNotThrow(() => pricing.quote({ ...base, color: 15, fabric: 'shot', payment: 'Transferencia' }));
});

test('envío exige aceptación explícita y domicilio', () => {
  const c = { name: 'Ana Perez', email: 'a@b.com', dni: '30123456', phone: '+54 261 555-1234', delivery: 'shipping', address: 'Calle 123 Godoy Cruz' };
  assert.throws(() => pricing.customerData({ ...c, shippingAccepted: false }));
  assert.equal(pricing.customerData({ ...c, shippingAccepted: true }).shippingAccepted, true);
});

test('pago de Mercado Pago que no coincide con el pedido queda en revisión', () => {
  const row = { id: 'abc', due_cents: 36794500, payload: { selection: { ...base, payment: 'Mercado Pago' }, collector: 99 } };
  const p = { external_reference: 'abc', collector_id: 99, currency_id: 'ARS', transaction_amount: 367945, live_mode: false, payment_type_id: 'account_money', status: 'approved' };
  assert.equal(pricing.paymentState(p, row, false), 'paid_test');
  assert.equal(pricing.paymentState({ ...p, transaction_amount: 1 }, row, false), 'review');
  assert.equal(pricing.paymentState({ ...p, collector_id: 1 }, row, false), 'review');
});

test('firma del webhook: válida acepta, alterada rechaza', () => {
  const secret = 'secreto-de-prueba';
  const id = '123456', rid = 'req-1', ts = '1700000000';
  const v1 = crypto.createHmac('sha256', secret).update(`id:${id};request-id:${rid};ts:${ts};`).digest('hex');
  const sig = `ts=${ts},v1=${v1}`;
  assert.equal(verifySignature(secret, id, rid, sig), true);
  assert.equal(verifySignature(secret, '999999', rid, sig), false);
  assert.equal(verifySignature('otro', id, rid, sig), false);
  assert.equal(verifySignature(secret, id, rid, null), false);
});
