'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const config = require('./lib/config');
const db = require('./lib/db');
const mp = require('./lib/mercadopago');
const pricing = require('./lib/pricing');
const { verifySignature } = require('./lib/webhook-signature');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const httpError = (status, message) => Object.assign(new Error(message), { status });

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req, name) {
  const found = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
}

// Cada pedido se entrega con una cookie httpOnly que solo tiene el comprador.
// No se confía en encabezados enviados por el cliente.
function requireAdmin(req, res, next) {
  const [scheme, b64] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && b64 && config.adminPassword) {
    const [user, ...rest] = Buffer.from(b64, 'base64').toString().split(':');
    if (safeEqual(user, config.adminUser) && safeEqual(rest.join(':'), config.adminPassword)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Sophie admin"').status(401).json({ error: 'Acceso restringido.' });
}

const STATUS_LABEL = {
  awaiting_transfer: 'Esperando transferencia', creating_checkout: 'Preparando pago', pending: 'Pendiente de pago',
  paid: 'Pagado', paid_test: 'Pago de prueba aprobado', rejected: 'Pago rechazado', cancelled: 'Cancelado',
  refunded: 'Reintegrado', charged_back: 'Contracargo', review: 'En revisión', checkout_error: 'Error al abrir Mercado Pago',
};

function view(row, { owner = false } = {}) {
  const p = row.payload;
  const out = {
    id: row.id,
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] || row.status,
    mode: p.mode,
    amount: row.due_cents / 100,
    total: row.total_cents / 100,
    balance: (row.total_cents - row.due_cents) / 100,
    product: p.product,
    selection: p.selection,
    customer: { name: p.customer.name, email: p.customer.email, delivery: p.customer.delivery },
    transfer: row.status === 'awaiting_transfer' ? p.bank : null,
    checkoutUrl: row.status === 'pending' && p.checkoutUrl ? p.checkoutUrl : null,
    createdAt: row.created_at,
  };
  if (owner) out.bankConfirmation = p.bankConfirmation || null;
  return out;
}

// Aplica un pago de Mercado Pago ya consultado a la API. Nunca confía en datos del cliente.
async function applyPayment(row, p) {
  const live = config.live;
  if (row.payload.channel !== 'mp' || row.payload.mode !== config.mode) return;
  const state = pricing.paymentState(p, row, live);
  const approved = ['paid', 'paid_test'];
  // Un segundo intento fallido no debe degradar un pago ya aprobado.
  if (['paid', 'paid_test', 'refunded', 'charged_back'].includes(row.status) && String(row.mp_id) !== String(p.id)) {
    if (approved.includes(state)) await db.setStatus(row.id, 'review');
    return;
  }
  if (row.status === 'review') return;
  await db.setStatus(row.id, state, String(p.id));
}

async function reconcile(row) {
  if (!config.mpEnabled || row.payload.channel !== 'mp' || row.payload.mode !== config.mode) return row;
  if (!['pending', 'creating_checkout'].includes(row.status)) return row;
  const found = await mp.searchPayments(row.id);
  const payments = (found.results || []).filter((p) => p.external_reference === row.id);
  const states = payments.map((p) => ({ p, status: pricing.paymentState(p, row, config.live) }));
  const paid = states.filter((x) => ['paid', 'paid_test'].includes(x.status));
  if (paid.length > 1) await db.setStatus(row.id, 'review', String(paid[0].p.id));
  else if (paid.length === 1) await db.setStatus(row.id, paid[0].status, String(paid[0].p.id));
  else if (states.length) await db.setStatus(row.id, states[0].status, String(states[0].p.id));
  return db.byId(row.id);
}

// Estado público del checkout (usado por checkout-payment.js).
app.get('/api/checkout', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    enabled: config.mpEnabled,
    mode: config.mode,
    transferEnabled: config.transferEnabled,
  });
});

app.post('/api/checkout', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.action !== 'create' || !/^[\w-]{8,64}$/.test(b.requestId || '')) throw httpError(400, 'Solicitud inválida.');
    const q = pricing.quote(b.selection);
    const customer = pricing.customerData(b.customer);
    const transfer = q.selection.payment === 'Transferencia';
    if (transfer ? !config.transferEnabled : !config.mpEnabled) {
      throw httpError(503, transfer
        ? 'La cuenta para transferencias todavía no está habilitada.'
        : 'El pago online todavía no está habilitado. No se realizó ningún cobro.');
    }

    // Reintento con el mismo requestId: devolver el pedido existente sin duplicar cobros.
    const existing = await db.byRequest(b.requestId);
    if (existing) {
      if (JSON.stringify(existing.payload.selection) !== JSON.stringify(q.selection) ||
          JSON.stringify(existing.payload.customer) !== JSON.stringify(customer)) {
        throw httpError(409, 'Este intento pertenece a otra selección.');
      }
      return respondWithOrder(req, res, existing);
    }

    const id = crypto.randomUUID();
    const accessToken = crypto.randomBytes(24).toString('base64url');
    const payload = {
      selection: q.selection,
      customer,
      product: pricing.productFor(q.selection),
      channel: transfer ? 'transfer' : 'mp',
      mode: config.mode,
      bank: transfer ? config.bank : null,
    };
    const inserted = await db.insert({
      id, requestId: b.requestId, accessToken,
      channel: payload.channel, mode: payload.mode,
      status: transfer ? 'awaiting_transfer' : 'creating_checkout',
      total: q.total, due: q.due, payload: JSON.stringify(payload),
    });
    if (!inserted) return respondWithOrder(req, res, await db.byRequest(b.requestId));

    if (!transfer) {
      const row = await db.byId(id);
      const origin = config.baseUrl || `${req.protocol}://${req.get('host')}`;
      try {
        const collector = await mp.sellerId();
        const types = await mp.paymentTypes();
        if (!Array.isArray(types) || !types.some((t) => t.id === q.type)) {
          throw httpError(400, 'Este medio de pago no está disponible.');
        }
        const back = `${origin}/pago.html?id=${id}`;
        const pref = await mp.createPreference({
          items: [{
            id: String(q.selection.model),
            title: 'Sophie · ' + (q.credit ? '' : 'Seña 50% · ') + payload.product.name,
            quantity: 1,
            currency_id: 'ARS',
            unit_price: q.due / 100,
          }],
          payer: { name: customer.name, email: customer.email, identification: { type: 'DNI', number: customer.dni } },
          external_reference: id,
          back_urls: { success: back, pending: back, failure: back },
          auto_return: 'approved',
          payment_methods: pricing.paymentMethodsFor(q.type, types),
          expires: true,
          expiration_date_to: new Date(Date.now() + 24 * 3600000).toISOString(),
          ...(config.webhookSecret ? { notification_url: origin + '/api/webhooks/mercadopago' } : {}),
          metadata: { order_id: id },
          statement_descriptor: 'SOPHIE LIVING',
        });
        const url = mp.checkoutUrl(pref);
        if (!url || String(pref.collector_id) !== String(collector)) throw httpError(502, 'No se pudo validar el destino del pago.');
        payload.collector = collector;
        payload.checkoutUrl = url;
        payload.preferenceId = pref.id;
        await db.setPayload(id, JSON.stringify(payload), 'pending');
      } catch (err) {
        // Se conserva el intento para revisión: no se crea otro cobro automáticamente.
        await db.setStatus(id, 'checkout_error');
        if (err.status && err.status < 500) throw err;
        return res.status(502).json({ error: 'No se pudo abrir Mercado Pago. Conservamos el pedido; no repitas el pago.', id });
      }
    }
    return respondWithOrder(req, res, await db.byId(id));
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({ error: status >= 500 ? 'No pudimos procesar el pedido. Intentá de nuevo en unos minutos.' : err.message });
  }
});

function respondWithOrder(req, res, row) {
  // Cookie de acceso del comprador: 30 días, solo para este pedido.
  res.cookie('ord_' + row.id, row.access_token, {
    httpOnly: true, secure: req.secure || config.baseUrl.startsWith('https'), sameSite: 'lax',
    path: '/', maxAge: 30 * 24 * 3600 * 1000,
  });
  res.set('Cache-Control', 'no-store').json(view(row));
}

app.get('/api/orders/:id', async (req, res) => {
  try {
    const row = await db.byId(req.params.id);
    const token = readCookie(req, 'ord_' + req.params.id);
    if (!row || !token || !safeEqual(token, row.access_token)) return res.status(404).json({ error: 'Pedido no encontrado.' });
    const current = await reconcile(row);
    res.set('Cache-Control', 'no-store').json(view(current));
  } catch {
    res.status(502).json({ error: 'No pudimos verificar el pago ahora. No repitas el cobro; volvé a consultar este pedido.' });
  }
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const rows = await db.list();
  res.set('Cache-Control', 'no-store').json({ orders: rows.map((r) => view(r, { owner: true })) });
});

// Confirmación manual de transferencias: el importe debe coincidir con el pedido.
app.post('/api/admin/orders/:id/confirm-transfer', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const row = await db.byId(req.params.id);
  if (!row || row.status !== 'awaiting_transfer') return res.status(409).json({ error: 'El pedido no está esperando transferencia.' });
  if (Math.round(Number(b.amount) * 100) !== row.due_cents) return res.status(400).json({ error: 'El importe no coincide con la seña.' });
  if (typeof b.reference !== 'string' || b.reference.trim().length < 4 || b.reference.length > 200) {
    return res.status(400).json({ error: 'Ingresá la referencia bancaria.' });
  }
  const payload = { ...row.payload, bankConfirmation: { reference: b.reference.trim(), at: new Date().toISOString() } };
  await db.setPayload(row.id, JSON.stringify(payload), 'paid');
  res.json({ id: row.id, status: 'paid' });
});

// Notificaciones de Mercado Pago. Son públicas pero firmadas (HMAC SHA-256).
app.post('/api/webhooks/mercadopago', async (req, res) => {
  const dataId = String(req.query['data.id'] || '');
  if (!verifySignature(config.webhookSecret, dataId, req.get('x-request-id'), req.get('x-signature'))) {
    return res.status(401).end();
  }
  try {
    if (!config.mpEnabled) return res.status(503).end();
    const p = await mp.getPayment(dataId);
    if (!p.external_reference) return res.status(200).end();
    const row = await db.byId(p.external_reference);
    if (row) await applyPayment(row, p);
    res.status(200).end();
  } catch {
    res.status(500).end(); // Mercado Pago reintenta
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Solicitud inválida.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Solicitud demasiado grande.' });
  res.status(500).json({ error: 'Error interno.' });
});

db.init()
  .then(() => app.listen(config.port, () => console.log(`Sophie Living en puerto ${config.port} (modo ${config.mode})`)))
  .catch((e) => { console.error('No se pudo iniciar la base de datos:', e.message); process.exit(1); });
