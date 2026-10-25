'use strict';
const METHODS = ['Mercado Pago', 'Transferencia', 'Tarjeta de débito', 'Tarjeta de crédito'];

const bad = (msg = 'Revisá la selección del producto.') => Object.assign(new Error(msg), { status: 400 });

// Valida la selección contra el catálogo cargado desde la base.
function resolveSelection(product, input) {
  if (!product || !product.active) throw bad('Ese modelo no está disponible.');
  if (!input || typeof input !== 'object') throw bad();
  if (!METHODS.includes(input.payment)) throw bad('Elegí la forma de pago.');

  const orientation = product.allowsOrientation ? input.orientation : 'left';
  if (product.allowsOrientation && !['left', 'right'].includes(orientation)) throw bad('Elegí izquierda o derecha.');

  const findColor = (id) => product.colors.find((c) => c.id === id);
  const colorLeft = findColor(input.colorLeft);
  if (!colorLeft) throw bad(product.colorMode === 'split' ? 'Elegí el color de la pieza izquierda.' : 'Elegí el color.');
  let colorRight = colorLeft;
  if (product.colorMode === 'split') {
    colorRight = findColor(input.colorRight);
    if (!colorRight) throw bad('Elegí el color de la pieza derecha.');
  }

  let leg = null;
  if (product.allowsLegs) {
    leg = product.legs.find((l) => l.id === input.legId);
    if (!leg) throw bad('Elegí las patas o la madera.');
  }
  return { product, orientation, colorLeft, colorRight, leg, payment: input.payment };
}

// settings = { interestPercent, senaPercent } (globales, desde el panel).
// - Tarjeta de crédito: precio con tarjeta del producto + interés global. Cuotas: hasta product.maxInstallments.
// - Resto de medios: la seña es el porcentaje global (senaPercent) del total.
function quote(r, settings) {
  const credit = r.payment === 'Tarjeta de crédito';
  const base = credit ? r.product.priceCredit : r.product.priceCash;
  const surcharge = Math.max(r.colorLeft.surcharge, r.colorRight.surcharge);
  const legExtra = r.leg ? r.leg.extra : 0;
  const withTela = Math.round((base * (100 + surcharge)) / 100);
  const interest = credit ? Number(settings.interestPercent) || 0 : 0;
  const total = Math.round((withTela * (100 + interest)) / 100) + legExtra;
  const due = credit ? total : Math.round((total * Number(settings.senaPercent)) / 100);
  const type = credit ? 'credit_card' : r.payment === 'Tarjeta de débito' ? 'debit_card' : 'account_money';
  return {
    total, due, balance: total - due, credit, type, surcharge, legExtra, interest,
    senaPercent: credit ? 100 : Number(settings.senaPercent),
    maxInstallments: credit ? r.product.maxInstallments : 1,
  };
}

function snapshot(r) {
  return {
    name: r.product.name,
    size: r.product.size,
    colorMode: r.product.colorMode,
    orientation: r.product.allowsOrientation ? (r.orientation === 'right' ? 'Derecha' : 'Izquierda') : null,
    colorLeft: { name: r.colorLeft.name, fabric: r.colorLeft.fabric },
    colorRight: { name: r.colorRight.name, fabric: r.colorRight.fabric },
    leg: r.leg ? r.leg.name : null,
  };
}

function customerData(c) {
  const invalid = () => Object.assign(new Error('Revisá los datos del comprador.'), { status: 400 });
  if (!c || typeof c.name !== 'string' || c.name.trim().length < 2 || c.name.length > 120) throw invalid();
  if (typeof c.email !== 'string' || c.email.length > 200 || !/^\S+@\S+\.\S+$/.test(c.email)) throw invalid();
  if (typeof c.dni !== 'string' || !/^\d{7,9}$/.test(c.dni)) throw invalid();
  if (typeof c.phone !== 'string' || !/^\+?[\d\s()-]{7,40}$/.test(c.phone)) throw invalid();
  if (!['pickup', 'shipping'].includes(c.delivery)) throw invalid();
  if (c.delivery === 'shipping') {
    if (typeof c.address !== 'string' || c.address.trim().length < 8 || c.address.length > 500) {
      throw Object.assign(new Error('Completá el domicilio para el envío.'), { status: 400 });
    }
    if (c.shippingAccepted !== true) {
      throw Object.assign(new Error('Aceptá que el envío se cotiza aparte.'), { status: 400 });
    }
  }
  return {
    name: c.name.trim(), email: c.email.trim(), dni: c.dni, phone: c.phone.trim(),
    delivery: c.delivery,
    address: c.delivery === 'shipping' ? c.address.trim() : '',
    shippingAccepted: c.delivery === 'shipping',
  };
}

function paymentMethodsFor(type, types, maxInstallments) {
  return {
    excluded_payment_types: types.filter((t) => t.id !== type && t.id !== 'account_money').map((t) => ({ id: t.id })),
    installments: type === 'credit_card' ? maxInstallments : 1,
  };
}

function paymentState(p, row, live) {
  const { collector, expectedType } = row.payload;
  if (
    String(p.external_reference) !== row.id ||
    String(p.collector_id) !== String(collector) ||
    p.currency_id !== 'ARS' ||
    Math.round(Number(p.transaction_amount) * 100) !== row.due_cents ||
    p.live_mode !== live
  ) return 'review';
  if (![expectedType, 'account_money'].includes(p.payment_type_id)) return 'review';
  if (p.status === 'approved') {
    if (Number(p.transaction_amount_refunded) > 0) return 'refunded';
    return live ? 'paid' : 'paid_test';
  }
  const map = { refunded: 'refunded', charged_back: 'charged_back', in_mediation: 'review', rejected: 'rejected', cancelled: 'cancelled' };
  return map[p.status] || 'pending';
}

module.exports = { METHODS, resolveSelection, quote, snapshot, customerData, paymentMethodsFor, paymentState };
