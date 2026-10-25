'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const pricing = require('../lib/pricing');
const { verifySignature } = require('../lib/webhook-signature');
const { sniffImage } = require('../lib/images');

const S = { interestPercent: 0, senaPercent: 50 };
const SI = { interestPercent: 10, senaPercent: 30 };
const shot = { id: 'f1', name: 'Shot', surcharge: 0 };
const best = { id: 'f2', name: 'Best', surcharge: 5 };
const product = {
  id: 'p1', name: 'Sofá Test', size: '2 m', active: true,
  priceCash: 73589000, priceCredit: 98689000, maxInstallments: 12,
  allowsOrientation: true, colorMode: 'split', allowsLegs: true,
  colors: [
    { id: 'c1', name: 'Gris', fabric: 'Shot', surcharge: 0 },
    { id: 'c2', name: 'Azul', fabric: 'Best', surcharge: 5 },
  ],
  legs: [{ id: 'l1', name: 'Madera', extra: 1000000 }],
};

test('contado: seña 50% y extra de patas', () => {
  const r = pricing.resolveSelection(product, { orientation: 'right', colorLeft: 'c1', colorRight: 'c1', legId: 'l1', payment: 'Transferencia' });
  const q = pricing.quote(r, S);
  assert.equal(q.total, 73589000 + 1000000);
  assert.equal(q.due, Math.round(q.total / 2));
});

test('recargo de tela: se aplica el mayor de las dos piezas', () => {
  const r = pricing.resolveSelection(product, { orientation: 'left', colorLeft: 'c1', colorRight: 'c2', legId: 'l1', payment: 'Mercado Pago' });
  assert.equal(pricing.quote(r, S).surcharge, 5);
});

test('crédito cobra el total íntegro', () => {
  const r = pricing.resolveSelection(product, { orientation: 'left', colorLeft: 'c1', colorRight: 'c1', legId: 'l1', payment: 'Tarjeta de crédito' });
  const q = pricing.quote(r, S);
  assert.equal(q.due, q.total);
  assert.equal(q.type, 'credit_card');
});

test('color inexistente o de otro producto se rechaza', () => {
  assert.throws(() => pricing.resolveSelection(product, { orientation: 'left', colorLeft: 'nope', colorRight: 'c1', legId: 'l1', payment: 'Transferencia' }));
});

test('patas obligatorias si el producto las ofrece', () => {
  assert.throws(() => pricing.resolveSelection(product, { orientation: 'left', colorLeft: 'c1', colorRight: 'c1', payment: 'Transferencia' }));
});

test('producto inactivo no se vende', () => {
  assert.throws(() => pricing.resolveSelection({ ...product, active: false }, { colorLeft: 'c1', payment: 'Transferencia' }));
});

test('modo de color único ignora la pieza derecha', () => {
  const single = { ...product, colorMode: 'single', allowsOrientation: false, allowsLegs: false };
  const r = pricing.resolveSelection(single, { colorLeft: 'c1', payment: 'Transferencia' });
  assert.equal(r.colorRight.id, 'c1');
  assert.equal(r.orientation, 'left');
});

test('envío exige aceptación y domicilio', () => {
  const c = { name: 'Ana Perez', email: 'a@b.com', dni: '30123456', phone: '+54 261 555-1234', delivery: 'shipping', address: 'Calle 123 Godoy Cruz' };
  assert.throws(() => pricing.customerData({ ...c, shippingAccepted: false }));
  assert.equal(pricing.customerData({ ...c, shippingAccepted: true }).shippingAccepted, true);
});

test('pago de Mercado Pago que no coincide queda en revisión', () => {
  const row = { id: 'abc', due_cents: 36794500, payload: { collector: 99, expectedType: 'account_money' } };
  const p = { external_reference: 'abc', collector_id: 99, currency_id: 'ARS', transaction_amount: 367945, live_mode: false, payment_type_id: 'account_money', status: 'approved' };
  assert.equal(pricing.paymentState(p, row, false), 'paid_test');
  assert.equal(pricing.paymentState({ ...p, transaction_amount: 1 }, row, false), 'review');
  assert.equal(pricing.paymentState({ ...p, collector_id: 1 }, row, false), 'review');
});

test('firma del webhook válida', () => {
  const secret = 'secreto-de-prueba';
  const v1 = crypto.createHmac('sha256', secret).update('id:123456;request-id:req-1;ts:1700000000;').digest('hex');
  const sig = `ts=1700000000,v1=${v1}`;
  assert.equal(verifySignature(secret, '123456', 'req-1', sig), true);
  assert.equal(verifySignature(secret, '999999', 'req-1', sig), false);
  assert.equal(verifySignature('otro', '123456', 'req-1', sig), false);
});

test('detección de imágenes por contenido', () => {
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
  assert.equal(sniffImage(jpg), 'image/jpeg');
  assert.equal(sniffImage(png), 'image/png');
  assert.equal(sniffImage(webp), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<html><script>alert(1)</script></html>')), null);
});

test('interés de cuotas: solo se aplica a tarjeta de crédito', () => {
  const credit = pricing.quote(pricing.resolveSelection(product, { orientation: 'left', colorLeft: 'c1', colorRight: 'c1', legId: 'l1', payment: 'Tarjeta de crédito' }), SI);
  assert.equal(credit.total, Math.round(98689000 * 1.1) + 1000000);
  assert.equal(credit.maxInstallments, 12);
  const transfer = pricing.quote(pricing.resolveSelection(product, { orientation: 'left', colorLeft: 'c1', colorRight: 'c1', legId: 'l1', payment: 'Transferencia' }), SI);
  assert.equal(transfer.total, 73589000 + 1000000);
  assert.equal(transfer.due, Math.round(transfer.total * 0.30));
});

test('seña global se aplica a transferencia y MP, no a crédito', () => {
  const r = pricing.resolveSelection(product, { orientation: 'left', colorLeft: 'c1', colorRight: 'c1', legId: 'l1', payment: 'Mercado Pago' });
  assert.equal(pricing.quote(r, { interestPercent: 0, senaPercent: 40 }).due, Math.round(pricing.quote(r, S).total * 0.4));
});

test('cuotas: sin cuotas para medios que no son crédito', () => {
  const r = pricing.resolveSelection(product, { orientation: 'left', colorLeft: 'c1', colorRight: 'c1', legId: 'l1', payment: 'Transferencia' });
  assert.equal(pricing.quote(r, S).maxInstallments, 1);
});
