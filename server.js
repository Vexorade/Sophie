'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const config = require('./lib/config');
const db = require('./lib/db');
const mp = require('./lib/mercadopago');
const pricing = require('./lib/pricing');
const { loadCatalog } = require('./lib/catalog');
const { stats } = require('./lib/stats');
const { sniffImage, MAX_BYTES } = require('./lib/images');
const { verifySignature } = require('./lib/webhook-signature');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.get('/', (req, res) => res.redirect('/configurador.html'));
app.get('/pedidos.html', (req, res) => res.redirect('/admin.html'));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], index: false }));

const httpError = (status, message) => Object.assign(new Error(message), { status });
const bool = (v) => v === true || v === 'true';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req, name) {
  const found = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
}

// Panel de administración: usuario y contraseña (Basic Auth) desde variables de entorno.
function requireAdmin(req, res, next) {
  const [scheme, b64] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && b64 && config.adminPassword) {
    const [user, ...rest] = Buffer.from(b64, 'base64').toString().split(':');
    if (safeEqual(user, config.adminUser) && safeEqual(rest.join(':'), config.adminPassword)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Sophie admin"').status(401).json({ error: 'Acceso restringido.' });
}
app.use('/api/admin', requireAdmin);

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
    fulfillment: row.fulfillment,
    rejectReason: row.reject_reason,
    channel: p.channel,
    mode: p.mode,
    amount: row.due_cents / 100,
    total: row.total_cents / 100,
    balance: (row.total_cents - row.due_cents) / 100,
    product: p.product,
    selection: p.selection,
    customer: owner
      ? p.customer
      : { name: p.customer.name, email: p.customer.email, delivery: p.customer.delivery },
    transfer: row.status === 'awaiting_transfer' ? p.bank : null,
    checkoutUrl: row.status === 'pending' && p.checkoutUrl ? p.checkoutUrl : null,
    bankConfirmation: owner ? p.bankConfirmation || null : undefined,
    createdAt: row.created_at,
  };
  return out;
}

// --- Mercado Pago ---------------------------------------------------------

async function applyPayment(row, p) {
  if (row.payload.channel !== 'mp' || row.payload.mode !== config.mode) return;
  const state = pricing.paymentState(p, row, config.live);
  const approved = ['paid', 'paid_test'];
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

// --- Catálogo y cotización (público) --------------------------------------

app.get('/api/catalog', async (req, res) => {
  const cat = await loadCatalog();
  res.set('Cache-Control', 'public, max-age=60').json({
    products: cat.products.map((p) => ({
      id: p.id, name: p.name, description: p.description, category: p.category, size: p.size,
      priceCash: p.priceCash, priceCredit: p.priceCredit,
      allowsOrientation: p.allowsOrientation, colorMode: p.colorMode, allowsLegs: p.allowsLegs,
      imageIds: p.imageIds, colors: p.colors, legs: p.legs,
    })),
    legs: cat.legs.filter((l) => l.active),
  });
});

async function resolveFromBody(selection) {
  const cat = await loadCatalog();
  const product = cat.products.find((p) => p.id === (selection && selection.productId));
  const r = pricing.resolveSelection(product, selection || {});
  return { r, q: pricing.quote(r) };
}

app.post('/api/quote', async (req, res) => {
  try {
    const { r, q } = await resolveFromBody(req.body && req.body.selection);
    res.set('Cache-Control', 'no-store').json({
      product: r.product.name, total: q.total / 100, due: q.due / 100, balance: q.balance / 100,
      credit: q.credit, surcharge: q.surcharge,
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.get('/api/checkout', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ enabled: config.mpEnabled, mode: config.mode, transferEnabled: config.transferEnabled });
});

function respondWithOrder(req, res, row) {
  res.cookie('ord_' + row.id, row.access_token, {
    httpOnly: true, secure: (config.baseUrl || '').startsWith('https'), sameSite: 'lax',
    path: '/', maxAge: 30 * 24 * 3600 * 1000,
  });
  res.set('Cache-Control', 'no-store').json(view(row));
}

// --- Pedidos (cliente) ----------------------------------------------------

app.post('/api/checkout', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.action !== 'create' || !/^[\w-]{8,64}$/.test(b.requestId || '')) throw httpError(400, 'Solicitud inválida.');
    const customer = pricing.customerData(b.customer);
    const { r, q } = await resolveFromBody(b.selection);
    const transfer = r.payment === 'Transferencia';
    if (transfer ? !config.transferEnabled : !config.mpEnabled) {
      throw httpError(503, transfer
        ? 'La cuenta para transferencias todavía no está habilitada.'
        : 'El pago online todavía no está habilitado. No se realizó ningún cobro.');
    }

    // Reintento con el mismo requestId: se devuelve el pedido existente, sin duplicar cobros.
    const existing = await db.byRequest(b.requestId);
    if (existing) {
      if (JSON.stringify(existing.payload.customer) !== JSON.stringify(customer)) {
        throw httpError(409, 'Este intento pertenece a otro pedido.');
      }
      return respondWithOrder(req, res, existing);
    }

    const id = crypto.randomUUID();
    const payload = {
      selection: {
        productId: r.product.id, orientation: r.orientation,
        colorLeftId: r.colorLeft.id, colorRightId: r.colorRight.id,
        legId: r.leg ? r.leg.id : null, payment: r.payment,
      },
      product: pricing.snapshot(r),
      customer,
      channel: transfer ? 'transfer' : 'mp',
      mode: config.mode,
      expectedType: q.type,
      bank: transfer ? { account: config.bank.account, holder: config.bank.holder, bank: config.bank.bank } : null,
    };
    const inserted = await db.insertOrder({
      id, requestId: b.requestId, accessToken: crypto.randomBytes(24).toString('base64url'),
      channel: payload.channel, mode: payload.mode,
      status: transfer ? 'awaiting_transfer' : 'creating_checkout',
      total: q.total, due: q.due, payload: JSON.stringify(payload),
    });
    if (!inserted) return respondWithOrder(req, res, await db.byRequest(b.requestId));

    if (!transfer) {
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
            id: String(r.product.id),
            title: 'Sophie · ' + (q.credit ? '' : 'Seña 50% · ') + r.product.name,
            quantity: 1, currency_id: 'ARS', unit_price: q.due / 100,
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
    res.status(500).end();
  }
});

// --- Imágenes -------------------------------------------------------------

app.get('/img/:id', async (req, res) => {
  const r = await db.pool.query('SELECT mime, data FROM images WHERE id=$1', [req.params.id]);
  const row = r.rows[0];
  if (!row) return res.status(404).end();
  res.set('Content-Type', row.mime).set('Cache-Control', 'public, max-age=31536000, immutable').send(row.data);
});

app.post('/api/admin/images', express.raw({ type: 'image/*', limit: MAX_BYTES }), async (req, res) => {
  const mime = sniffImage(req.body);
  if (!mime) return res.status(400).json({ error: 'Subí una imagen JPG, PNG o WEBP.' });
  const id = crypto.randomUUID();
  await db.pool.query('INSERT INTO images (id, mime, data, bytes) VALUES ($1,$2,$3,$4)', [id, mime, req.body, req.body.length]);
  res.json({ id, url: '/img/' + id });
});

app.delete('/api/admin/images/:id', async (req, res) => {
  await db.pool.query('DELETE FROM images WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// --- Panel: catálogo ------------------------------------------------------

const str = (v, min, max, label) => {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length < min || t.length > max) throw httpError(400, `Revisá ${label}.`);
  return t;
};
const optStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const pesosToCents = (v, label) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e9) throw httpError(400, `Revisá ${label}.`);
  return Math.round(n * 100);
};
const idList = (v, max = 50) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, max) : []);

app.get('/api/admin/catalog', async (req, res) => res.json(await loadCatalog({ includeInactive: true })));
app.get('/api/admin/stats', async (req, res) => res.set('Cache-Control', 'no-store').json(await stats()));

app.post('/api/admin/products', async (req, res) => saveProduct(req, res, null));
app.put('/api/admin/products/:id', async (req, res) => saveProduct(req, res, req.params.id));

async function saveProduct(req, res, id) {
  try {
    const b = req.body || {};
    const f = {
      name: str(b.name, 2, 120, 'el nombre del producto'),
      description: optStr(b.description, 2000),
      category: optStr(b.category, 60),
      size: optStr(b.size, 120),
      priceCash: pesosToCents(b.priceCash, 'el precio de contado'),
      priceCredit: pesosToCents(b.priceCredit, 'el precio con tarjeta'),
      allowsOrientation: bool(b.allowsOrientation),
      colorMode: b.colorMode === 'split' ? 'split' : 'single',
      allowsLegs: bool(b.allowsLegs),
      active: b.active !== false && b.active !== 'false',
      sort: Number.isInteger(b.sort) ? b.sort : 0,
      imageIds: idList(b.imageIds, 20),
      colorIds: idList(b.colorIds, 200),
      legIds: idList(b.legIds, 50),
    };
    if (id) {
      const exists = await db.pool.query('SELECT 1 FROM products WHERE id=$1', [id]);
      if (!exists.rowCount) throw httpError(404, 'Producto no encontrado.');
    }
    const productId = id || crypto.randomUUID();
    await db.tx(async (c) => {
      await c.query(
        `INSERT INTO products (id,name,description,category,size,price_cash_cents,price_credit_cents,allows_orientation,
           color_mode,allows_legs,active,sort,image_ids,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, category=EXCLUDED.category,
           size=EXCLUDED.size, price_cash_cents=EXCLUDED.price_cash_cents, price_credit_cents=EXCLUDED.price_credit_cents,
           allows_orientation=EXCLUDED.allows_orientation, color_mode=EXCLUDED.color_mode, allows_legs=EXCLUDED.allows_legs,
           active=EXCLUDED.active, sort=EXCLUDED.sort, image_ids=EXCLUDED.image_ids, updated_at=now()`,
        [productId, f.name, f.description, f.category, f.size, f.priceCash, f.priceCredit, f.allowsOrientation,
          f.colorMode, f.allowsLegs, f.active, f.sort, f.imageIds]
      );
      const colors = (await c.query('SELECT id FROM fabric_colors WHERE id = ANY($1)', [f.colorIds])).rows.map((r) => r.id);
      await c.query('DELETE FROM product_fabric_colors WHERE product_id=$1', [productId]);
      for (const cid of colors) {
        await c.query('INSERT INTO product_fabric_colors (product_id, fabric_color_id) VALUES ($1,$2)', [productId, cid]);
      }
      const legs = f.allowsLegs ? (await c.query('SELECT id FROM legs WHERE id = ANY($1)', [f.legIds])).rows.map((r) => r.id) : [];
      await c.query('DELETE FROM product_legs WHERE product_id=$1', [productId]);
      for (const lid of legs) {
        await c.query('INSERT INTO product_legs (product_id, leg_id) VALUES ($1,$2)', [productId, lid]);
      }
    });
    res.json({ id: productId });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'No se pudo guardar el producto.' });
  }
}

app.delete('/api/admin/products/:id', async (req, res) => {
  // Los pedidos guardan su propia copia del producto, así que borrarlo no afecta el historial.
  await db.tx(async (c) => {
    const r = await c.query('SELECT image_ids FROM products WHERE id=$1', [req.params.id]);
    if (r.rows[0]) await c.query('DELETE FROM images WHERE id = ANY($1)', [r.rows[0].image_ids]);
    await c.query('DELETE FROM products WHERE id=$1', [req.params.id]);
  });
  res.json({ ok: true });
});

// --- Panel: telas y colores -----------------------------------------------

app.post('/api/admin/fabrics', async (req, res) => {
  const b = req.body || {};
  const id = crypto.randomUUID();
  await db.pool.query('INSERT INTO fabrics (id,name,surcharge_percent,active) VALUES ($1,$2,$3,$4)',
    [id, str(b.name, 1, 80, 'el nombre de la tela'), Math.max(0, Math.min(100, Math.round(Number(b.surcharge) || 0))), b.active !== false]);
  res.json({ id });
});
app.put('/api/admin/fabrics/:id', async (req, res) => {
  const b = req.body || {};
  await db.pool.query('UPDATE fabrics SET name=$2, surcharge_percent=$3, active=$4 WHERE id=$1',
    [req.params.id, str(b.name, 1, 80, 'el nombre de la tela'), Math.max(0, Math.min(100, Math.round(Number(b.surcharge) || 0))), b.active !== false]);
  res.json({ ok: true });
});
app.delete('/api/admin/fabrics/:id', async (req, res) => {
  await db.tx(async (c) => {
    const imgs = await c.query('SELECT image_id FROM fabric_colors WHERE fabric_id=$1', [req.params.id]);
    const ids = imgs.rows.map((r) => r.image_id).filter(Boolean);
    if (ids.length) await c.query('DELETE FROM images WHERE id = ANY($1)', [ids]);
    await c.query('DELETE FROM fabrics WHERE id=$1', [req.params.id]);
  });
  res.json({ ok: true });
});

app.post('/api/admin/fabric-colors', async (req, res) => {
  const b = req.body || {};
  const id = crypto.randomUUID();
  await db.pool.query('INSERT INTO fabric_colors (id,fabric_id,name,image_id,active) VALUES ($1,$2,$3,$4,$5)',
    [id, str(b.fabricId, 1, 100, 'la tela'), str(b.name, 1, 80, 'el nombre del color'), optStr(b.imageId, 100) || null, b.active !== false]);
  res.json({ id });
});
app.put('/api/admin/fabric-colors/:id', async (req, res) => {
  const b = req.body || {};
  await db.pool.query('UPDATE fabric_colors SET name=$2, image_id=$3, active=$4 WHERE id=$1',
    [req.params.id, str(b.name, 1, 80, 'el nombre del color'), optStr(b.imageId, 100) || null, b.active !== false]);
  res.json({ ok: true });
});
app.delete('/api/admin/fabric-colors/:id', async (req, res) => {
  await db.tx(async (c) => {
    const r = await c.query('DELETE FROM fabric_colors WHERE id=$1 RETURNING image_id', [req.params.id]);
    if (r.rows[0] && r.rows[0].image_id) await c.query('DELETE FROM images WHERE id=$1', [r.rows[0].image_id]);
  });
  res.json({ ok: true });
});

// --- Panel: maderas y patas -----------------------------------------------

app.post('/api/admin/legs', async (req, res) => {
  const b = req.body || {};
  const id = crypto.randomUUID();
  await db.pool.query('INSERT INTO legs (id,name,image_id,extra_cents,active) VALUES ($1,$2,$3,$4,$5)',
    [id, str(b.name, 1, 80, 'el nombre'), optStr(b.imageId, 100) || null, pesosToCents(b.extra || 0, 'el adicional'), b.active !== false]);
  res.json({ id });
});
app.put('/api/admin/legs/:id', async (req, res) => {
  const b = req.body || {};
  await db.pool.query('UPDATE legs SET name=$2, image_id=$3, extra_cents=$4, active=$5 WHERE id=$1',
    [req.params.id, str(b.name, 1, 80, 'el nombre'), optStr(b.imageId, 100) || null, pesosToCents(b.extra || 0, 'el adicional'), b.active !== false]);
  res.json({ ok: true });
});
app.delete('/api/admin/legs/:id', async (req, res) => {
  await db.tx(async (c) => {
    const r = await c.query('DELETE FROM legs WHERE id=$1 RETURNING image_id', [req.params.id]);
    if (r.rows[0] && r.rows[0].image_id) await c.query('DELETE FROM images WHERE id=$1', [r.rows[0].image_id]);
  });
  res.json({ ok: true });
});

// --- Panel: pedidos -------------------------------------------------------

app.get('/api/admin/orders', async (req, res) => {
  const rows = await db.list();
  res.set('Cache-Control', 'no-store').json({ orders: rows.map((r) => view(r, { owner: true })) });
});

async function fulfillmentAction(req, res, from, to, reason) {
  const row = await db.byId(req.params.id);
  if (!row) return res.status(404).json({ error: 'Pedido no encontrado.' });
  if (!from.includes(row.fulfillment)) {
    return res.status(409).json({ error: `Este pedido está en estado "${row.fulfillment}".` });
  }
  await db.setFulfillment(row.id, to, reason);
  res.json({ id: row.id, fulfillment: to });
}

app.post('/api/admin/orders/:id/accept', (req, res) => fulfillmentAction(req, res, ['nuevo', 'rechazado'], 'aceptado'));
app.post('/api/admin/orders/:id/deliver', (req, res) => fulfillmentAction(req, res, ['aceptado'], 'entregado'));
app.post('/api/admin/orders/:id/reject', (req, res) => {
  const reason = optStr((req.body || {}).reason, 300);
  return fulfillmentAction(req, res, ['nuevo', 'aceptado'], 'rechazado', reason || 'Sin motivo indicado');
});

// Confirmación manual de transferencias: el importe debe coincidir con la seña.
app.post('/api/admin/orders/:id/confirm-transfer', async (req, res) => {
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Solicitud inválida.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'El archivo es demasiado grande (máximo 2 MB).' });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Error interno.' });
});

db.init()
  .then(() => app.listen(config.port, () => console.log(`Sophie Living en puerto ${config.port} (modo ${config.mode})`)))
  .catch((e) => {
    console.error('No se pudo iniciar:', e.code || '', e.message || e);
    process.exit(1);
  });
