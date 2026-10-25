'use strict';
const CATALOG = require('../data/catalog.json');

const METHODS = ['Mercado Pago', 'Transferencia', 'Tarjeta de débito', 'Tarjeta de crédito'];
const PENDING_MODELS = new Set([4]); // Luxury Panamá/Tussor: telas pendientes, no se vende todavía
const FABRICS = {
  shot: { colors: 18, percent: 100 },
  best: { colors: 15, percent: 105 }, // Pana Best +5%
};
const LEGS = ['wood', 'ball', 'aluminum'];
const SIDES = ['left', 'right'];

const badSelection = () =>
  new Error('Revisá el modelo, la tela, el color, las patas y la forma de pago.');

function validateSelection(s) {
  if (!s || !Number.isInteger(s.model) || !CATALOG.prices[s.model] || PENDING_MODELS.has(s.model)) throw badSelection();
  if (!Object.hasOwn(FABRICS, s.fabric)) throw badSelection();
  if (!Number.isInteger(s.color) || s.color < 0 || s.color >= FABRICS[s.fabric].colors) throw badSelection();
  if (!SIDES.includes(s.side) || !LEGS.includes(s.legs) || !METHODS.includes(s.payment)) throw badSelection();
  return { model: s.model, fabric: s.fabric, color: s.color, side: s.side, legs: s.legs, payment: s.payment };
}

// Montos en centavos. Contado/débito/saldo MP: seña del 50%. Crédito: total de lista.
function quote(input) {
  const s = validateSelection(input);
  const credit = s.payment === 'Tarjeta de crédito';
  const price = CATALOG.prices[s.model];
  const base = credit ? price.credit : price.cash;
  const total = Math.round(base * 100 * FABRICS[s.fabric].percent / 100);
  const due = credit ? total : Math.round(total / 2);
  const type = credit ? 'credit_card' : s.payment === 'Tarjeta de débito' ? 'debit_card' : 'account_money';
  return { selection: s, total, due, balance: total - due, credit, type };
}

function customerData(c) {
  const bad = () => new Error('Revisá los datos del comprador.');
  if (!c || typeof c.name !== 'string' || c.name.trim().length < 2 || c.name.length > 120) throw bad();
  if (typeof c.email !== 'string' || c.email.length > 200 || !/^\S+@\S+\.\S+$/.test(c.email)) throw bad();
  if (typeof c.dni !== 'string' || !/^\d{7,9}$/.test(c.dni)) throw bad();
  if (typeof c.phone !== 'string' || !/^\+?[\d\s()-]{7,40}$/.test(c.phone)) throw bad();
  if (!['pickup', 'shipping'].includes(c.delivery)) throw bad();
  if (c.delivery === 'shipping') {
    if (typeof c.address !== 'string' || c.address.trim().length < 8 || c.address.length > 500) {
      throw new Error('Completá el domicilio para el envío.');
    }
    if (c.shippingAccepted !== true) throw new Error('Aceptá que el envío se cotiza aparte.');
  }
  return {
    name: c.name.trim(),
    email: c.email.trim(),
    dni: c.dni,
    phone: c.phone.trim(),
    delivery: c.delivery,
    address: c.delivery === 'shipping' ? c.address.trim() : '',
    shippingAccepted: c.delivery === 'shipping',
  };
}

// Solo se ofrecen los medios elegidos: se excluye todo lo demás salvo saldo MP.
function paymentMethodsFor(type, types) {
  return {
    excluded_payment_types: types.filter((t) => t.id !== type && t.id !== 'account_money').map((t) => ({ id: t.id })),
    installments: type === 'credit_card' ? 18 : 1,
  };
}

function productFor(s) {
  const colors = s.fabric === 'best' ? CATALOG.best : CATALOG.shot;
  const m = CATALOG.models[s.model];
  return {
    name: m.name,
    size: m.size,
    fabric: s.fabric === 'best' ? 'Pana Best' : 'Pana Shot',
    color: colors[s.color],
    legs: CATALOG.legs[s.legs],
    side: s.side === 'left' ? 'Izquierda' : 'Derecha',
  };
}

// Verifica que un pago de Mercado Pago coincida exactamente con el pedido.
function paymentState(p, row, live) {
  const { selection, collector } = row.payload;
  const q = quote(selection);
  if (
    String(p.external_reference) !== row.id ||
    String(p.collector_id) !== String(collector) ||
    p.currency_id !== 'ARS' ||
    Math.round(Number(p.transaction_amount) * 100) !== row.due_cents ||
    p.live_mode !== live
  ) return 'review';
  if (![q.type, 'account_money'].includes(p.payment_type_id)) return 'review';
  if (p.status === 'approved') {
    if (Number(p.transaction_amount_refunded) > 0) return 'refunded';
    return live ? 'paid' : 'paid_test';
  }
  const map = { refunded: 'refunded', charged_back: 'charged_back', in_mediation: 'review', rejected: 'rejected', cancelled: 'cancelled' };
  return map[p.status] || 'pending';
}

module.exports = { quote, customerData, validateSelection, paymentMethodsFor, productFor, paymentState, METHODS };
