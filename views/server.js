'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const config = require('./lib/config');
const db = require('./lib/db');
const mp = require('./lib/mercadopago');
const pricing = require('./lib/pricing');
const { loadCatalog } = require('./lib/catalog');
const { stats, bounds } = require('./lib/stats');
const { seedLegacy, applyLegacyOnce } = require('./lib/seed');
const fs = require('fs');
const { sniffImage, MAX_BYTES } = require('./lib/images');
const { verifySignature } = require('./lib/webhook-signature');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.get('/', (req, res) => res.redirect('/configurador.html'));

// --- Configurador: la plantilla original, con los datos de la base inyectados ---
const CONFIG_TEMPLATE = fs.readFileSync(path.join(__dirname, 'views', 'configurador.html'), 'utf8');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SOCIAL_LABEL = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', x: 'X', linkedin: 'LinkedIn', email: 'Email', other: 'Enlace' };

function socialsHtml(site) {
  const links = (site.socials || []).filter((s) => s && s.url).map((s) =>
    `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(SOCIAL_LABEL[s.type] || 'Enlace')}</a>`);
  return links.length ? `<nav class="socials" aria-label="Redes">${links.join('')}</nav>` : '';
}
function whatsappHtml(site) {
  const digits = String(site.whatsapp || '').replace(/\D/g, '');
  if (digits.length < 8) return '';
  const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.2 0-.523.074-.797.359-.273.297-1.045 1.02-1.045 2.486s1.07 2.876 1.219 3.075c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>';
  return `<a id="waFloat" class="wa-float" href="https://wa.me/${digits}" target="_blank" rel="noopener" aria-label="Escribinos por WhatsApp" title="WhatsApp">${icon}</a>`;
}

async function buildConfigData() {
  const cat = await loadCatalog();
  const s = await db.getSettings();
  const site = s.site;
  const shot = cat.fabrics.find((f) => /shot/i.test(f.name));
  const best = cat.fabrics.find((f) => /best/i.test(f.name));
  const colorRow = (c) => [c.name, c.hex || null, c.imageId ? '/img/' + c.imageId : '', c.id];
  const products = cat.products.map((p) => {
    const first = p.imageIds[0] ? '/img/' + p.imageIds[0] : '';
    return {
      id: p.id, name: p.name, size: p.size, chaise: !!p.allowsOrientation, variants: [],
      fabricPending: !!p.fabricPending,
      reference: p.simulateColor ? null : first || null,
      base: first, thumb: first,
      // Máscaras del dibujo original, asociadas al modelo (no a su posición en la lista).
      mask: p.id === 'legacy-model-3' ? 'b' : 'a',
      noBottom: p.id === 'legacy-model-2',
      ref: p.id === 'legacy-model-3' ? 78 : p.id === 'legacy-model-2' ? 65 : 80,
      colorIds: p.colors.map((c) => c.id),
      legIds: p.legs.map((l) => l.id),
    };
  });
  const legs = cat.legs.filter((l) => l.active);
  return {
    models: products,
    priceCatalog: cat.products.map((p) => ({ cash: p.priceCash / 100, credit: p.priceCredit / 100 })),
    shotColors: shot ? shot.colors.filter((c) => c.active).map(colorRow) : [],
    bestColors: best ? best.colors.filter((c) => c.active).map(colorRow) : [],
    legOptions: Object.fromEntries(legs.map((l) => [l.id, l.name])),
    legImages: Object.fromEntries(legs.filter((l) => l.imageId).map((l) => ['' + l.id, '/img/' + l.imageId])),
    legExtra: Object.fromEntries(legs.map((l) => [l.id, l.extra / 100])),
    surcharge: { shot: shot ? shot.surcharge : 0, best: best ? best.surcharge : 0 },
    interest: Number(s.interestPercent) || 0,
    sena: Number(s.senaPercent),
    site: { deliveryAddress: site.deliveryAddress },
  };
}

async function renderConfigurator() {
  const data = await buildConfigData();
  const s = (await db.getSettings()).site;
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const brand = '/img/' + (s.brandImageId || 'seed-brand');
  const map = {
    '{{brandSrc}}': esc(brand),
    '{{headerLabel}}': esc(s.headerLabel),
    '{{introTitle}}': esc(s.introTitle),
    '{{introText}}': esc(s.introText),
    '{{footerText}}': esc(s.footerText),
    '{{deliveryAddress}}': esc(s.deliveryAddress),
    '{{socialsHtml}}': socialsHtml(s),
    '{{waFloat}}': whatsappHtml(s),
    '{{brandShape}}': 'shape-' + (['square', 'circle', 'rounded'].includes(s.brandShape) ? s.brandShape : 'square'),
  };
  let html = CONFIG_TEMPLATE.replace('/*__SOPHIE_DATA__*/null', json);
  for (const [k, v] of Object.entries(map)) html = html.split(k).join(v);
  return html;
}

app.get('/configurador.html', async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store').type('html').send(await renderConfigurator()); }
  catch (err) { next(err); }
});
app.get('/pedidos.html', (req, res) => res.redirect('/admin.html'));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], index: false }));

const httpError = (status, message) => Object.assign(new Error(message), { status });
const bool = (v) => v === true || v === 'true';
const SESSION_HOURS = 12;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function readCookie(req, name) {
  const found = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
}
const sign = (v) => crypto.createHmac('sha256', config.sessionSecret).update(v).digest('hex');
function makeSession() {
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  return `${exp}.${sign(String(exp))}`;
}
function validSession(tok) {
  const [exp, sig] = String(tok || '').split('.');
  if (!exp || !sig || Date.now() > Number(exp)) return false;
  return safeEqual(sig, sign(exp));
}
const cookieOpts = (req) => ({
  httpOnly: true, sameSite: 'strict', path: '/',
  secure: (config.baseUrl || '').startsWith('https') || req.secure,
});

// --- Inicio de sesión del panel (solo contraseña, dentro de la página) -----

const attempts = new Map();
function blocked(ip) {
  const a = attempts.get(ip);
  return !!a && a.n >= 8 && Date.now() < a.reset;
}
function failed(ip) {
  const a = attempts.get(ip) && Date.now() < attempts.get(ip).reset
    ? attempts.get(ip) : { n: 0, reset: Date.now() + 15 * 60e3 };
  a.n += 1;
  attempts.set(ip, a);
}

app.post('/api/admin/login', (req, res) => {
  if (!config.adminPassword) return res.status(503).json({ error: 'Falta configurar ADMIN_PASSWORD en el servidor.' });
  if (blocked(req.ip)) return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos.' });
  const pass = typeof (req.body || {}).password === 'string' ? req.body.password : '';
  if (!pass || !safeEqual(pass, config.adminPassword)) {
    failed(req.ip);
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }
  attempts.delete(req.ip);
  res.cookie('sophie_admin', makeSession(), { ...cookieOpts(req), maxAge: SESSION_HOURS * 3600e3 });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('sophie_admin', cookieOpts(req));
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  if (validSession(readCookie(req, 'sophie_admin'))) return res.json({ ok: true });
  res.status(401).json({ error: 'Iniciá sesión.' });
});

function requireAdmin(req, res, next) {
  if (validSession(readCookie(req, 'sophie_admin'))) return next();
  res.status(401).json({ error: 'Iniciá sesión para continuar.' });
}
app.use('/api/admin', requireAdmin);

// --- Estados y vista de pedidos ---------------------------------------------

const STATUS_LABEL = {
  awaiting_transfer: 'Esperando transferencia', creating_checkout: 'Preparando pago', pending: 'Pendiente de pago',
  paid: 'Pagado', paid_test: 'Pago de prueba aprobado', rejected: 'Pago rechazado', cancelled: 'Cancelado',
  refunded: 'Reintegrado', charged_back: 'Contracargo', review: 'En revisión', checkout_error: 'Error al abrir Mercado Pago',
};

function view(row, { owner = false } = {}) {
  const p = row.payload;
  return {
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
    product: p.product || {},
    selection: p.selection || {},
    customer: owner ? (p.customer || {}) : { name: (p.customer || {}).name, email: (p.customer || {}).email, delivery: (p.customer || {}).delivery },
    transfer: row.status === 'awaiting_transfer' ? p.bank : null,
    checkoutUrl: row.status === 'pending' && p.checkoutUrl ? p.checkoutUrl : null,
    bankConfirmation: owner ? p.bankConfirmation || null : undefined,
    createdAt: row.created_at,
  };
}

// --- Mercado Pago ----------------------------------------------------------

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

// --- Catálogo, cotización y estado (público) -------------------------------

app.get('/api/catalog', async (req, res) => {
  const cat = await loadCatalog();
  res.set('Cache-Control', 'no-store').json({
    products: cat.products.map((p) => ({
      id: p.id, name: p.name, description: p.description, category: p.category, size: p.size,
      priceCash: p.priceCash, priceCredit: p.priceCredit, maxInstallments: p.maxInstallments,
      allowsOrientation: p.allowsOrientation, colorMode: p.colorMode, allowsLegs: p.allowsLegs,
      imageIds: p.imageIds, colors: p.colors, legs: p.legs,
    })),
  });
});

async function resolveFromBody(selection) {
  const cat = await loadCatalog();
  const product = cat.products.find((p) => p.id === (selection && selection.productId));
  const r = pricing.resolveSelection(product, selection || {});
  const settings = await db.getSettings();
  return { r, q: pricing.quote(r, settings), settings };
}

app.post('/api/quote', async (req, res) => {
  try {
    const { r, q } = await resolveFromBody(req.body && req.body.selection);
    res.set('Cache-Control', 'no-store').json({
      product: r.product.name, total: q.total / 100, due: q.due / 100, balance: q.balance / 100,
      credit: q.credit, surcharge: q.surcharge, interest: q.interest,
      senaPercent: q.senaPercent, maxInstallments: q.maxInstallments,
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

function customerOrderView(row) {
  const p = row.payload;
  const pr = p.product || {};
  const color = pr.colorMode === 'split' && pr.colorLeft && pr.colorRight
    ? `${pr.colorLeft.name} (izq.) · ${pr.colorRight.name} (der.)`
    : pr.colorLeft ? pr.colorLeft.name : '';
  return {
    id: row.id,
    status: row.status,
    mode: p.mode,
    amount: row.due_cents / 100,
    total: row.total_cents / 100,
    balance: (row.total_cents - row.due_cents) / 100,
    product: {
      name: pr.name || '', size: pr.size || '',
      fabric: pr.colorLeft ? pr.colorLeft.fabric : '', color,
      legs: pr.leg || 'Sin patas', side: pr.orientation || '',
    },
    selection: { payment: (p.selection || {}).payment || '' },
    customer: { name: p.customer.name, delivery: p.customer.delivery, address: p.customer.address || '' },
    transfer: row.status === 'awaiting_transfer' ? p.bank : null,
    checkoutUrl: row.status === 'pending' && p.checkoutUrl ? p.checkoutUrl : null,
    canConfirmTransfer: false,
  };
}

app.get('/api/checkout', async (req, res) => {
  if (req.query.id !== undefined) {
    try {
      const id = String(req.query.id);
      if (!/^[a-f0-9-]{30,64}$/.test(id)) return res.status(400).json({ error: 'El enlace del pedido no es válido.' });
      const row = await db.byId(id);
      const token = readCookie(req, 'ord_' + id);
      if (!row || !token || !safeEqual(token, row.access_token)) return res.status(404).json({ error: 'Pedido no encontrado.' });
      const current = await reconcile(row);
      return res.set('Cache-Control', 'no-store').json(customerOrderView(current));
    } catch {
      return res.status(502).json({ error: 'No pudimos verificar el pago ahora. No repitas el cobro; volvé a consultar este pedido.' });
    }
  }
  const s = await db.getSettings();
  res.set('Cache-Control', 'no-store').json({
    enabled: config.mpEnabled, mode: config.mode, transferEnabled: config.transferEnabled,
    senaPercent: Number(s.senaPercent), interestPercent: Number(s.interestPercent),
  });
});

function respondWithOrder(req, res, row) {
  res.cookie('ord_' + row.id, row.access_token, {
    httpOnly: true, secure: (config.baseUrl || '').startsWith('https'), sameSite: 'lax',
    path: '/', maxAge: 30 * 24 * 3600 * 1000,
  });
  res.set('Cache-Control', 'no-store').json(view(row));
}

// --- Pedidos del cliente ---------------------------------------------------

app.post('/api/checkout', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.action === 'confirm_transfer') throw httpError(403, 'Las transferencias las confirma Sophie desde su panel.');
    if (b.action !== 'create' || !/^[\w-]{8,64}$/.test(b.requestId || '')) throw httpError(400, 'Solicitud inválida.');
    const customer = pricing.customerData(b.customer);
    const { r, q } = await resolveFromBody(b.selection);
    const transfer = r.payment === 'Transferencia';
    if (transfer ? !config.transferEnabled : !config.mpEnabled) {
      throw httpError(503, transfer
        ? 'La cuenta para transferencias todavía no está habilitada.'
        : 'El pago online todavía no está habilitado. No se realizó ningún cobro.');
    }

    const existing = await db.byRequest(b.requestId);
    if (existing) {
      if (JSON.stringify(existing.payload.customer) !== JSON.stringify(customer)) {
        throw httpError(409, 'Este intento pertenece a otro pedido.');
      }
      return respondWithOrder(req, res, existing);
    }

    const id = crypto.randomBytes(32).toString('hex');
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
      senaPercent: q.senaPercent,
      interest: q.interest,
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
            title: 'Sophie · ' + (q.credit ? '' : `Seña ${q.senaPercent}% · `) + r.product.name,
            quantity: 1, currency_id: 'ARS', unit_price: q.due / 100,
          }],
          payer: { name: customer.name, email: customer.email, identification: { type: 'DNI', number: customer.dni } },
          external_reference: id,
          back_urls: { success: back, pending: back, failure: back },
          auto_return: 'approved',
          payment_methods: pricing.paymentMethodsFor(q.type, types, q.maxInstallments),
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
  if (!verifySignature(config.webhookSecret, dataId, req.get('x-request-id'), req.get('x-signature'))) return res.status(401).end();
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

app.get('/img/:id', async (req, res) => {
  const r = await db.pool.query('SELECT mime, data FROM images WHERE id=$1', [req.params.id]);
  const row = r.rows[0];
  if (!row) return res.status(404).end();
  res.set('Content-Type', row.mime).set('Cache-Control', 'public, max-age=31536000, immutable').send(row.data);
});

// --- Panel: imágenes -------------------------------------------------------

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

// --- Panel: configuración global ------------------------------------------

app.get('/api/admin/settings', async (req, res) => res.json(await db.getSettings()));

const SOCIAL_TYPES = Object.keys(SOCIAL_LABEL);
app.get('/api/admin/site', async (req, res) => res.json((await db.getSettings()).site));
app.put('/api/admin/site', async (req, res) => {
  try {
    const b = req.body || {};
    const text = (v, label, max) => {
      const t = typeof v === 'string' ? v.trim() : '';
      if (!t || t.length > max) throw httpError(400, `Revisá ${label} (máximo ${max} caracteres).`);
      return t;
    };
    const brandImageId = typeof b.brandImageId === 'string' ? b.brandImageId : '';
    if (brandImageId) {
      const exists = await db.pool.query('SELECT 1 FROM images WHERE id=$1', [brandImageId]);
      if (!exists.rowCount) throw httpError(400, 'La foto de perfil no existe. Subila de nuevo.');
    }
    const whatsapp = String(b.whatsapp || '').replace(/\D/g, '');
    if (whatsapp && (whatsapp.length < 8 || whatsapp.length > 15)) throw httpError(400, 'Revisá el número de WhatsApp (con código de país, solo números).');
    const socials = (Array.isArray(b.socials) ? b.socials : []).slice(0, 12).map((s) => {
      const type = SOCIAL_TYPES.includes(s && s.type) ? s.type : 'other';
      const url = typeof (s && s.url) === 'string' ? s.url.trim() : '';
      if (!url) return null;
      if (type === 'email') {
        const addr = url.replace(/^mailto:/i, '');
        if (!/^\S+@\S+\.\S+$/.test(addr)) throw httpError(400, 'Revisá el email de contacto.');
        return { type, url: 'mailto:' + addr };
      }
      let u;
      try { u = new URL(url); } catch { throw httpError(400, `Revisá el enlace de ${SOCIAL_LABEL[type]}.`); }
      if (u.protocol !== 'https:') throw httpError(400, `El enlace de ${SOCIAL_LABEL[type]} tiene que empezar con https://`);
      return { type, url: u.href };
    }).filter(Boolean);
    const site = {
      headerLabel: text(b.headerLabel, 'el título del encabezado', 40),
      introTitle: text(b.introTitle, 'el título principal', 80),
      introText: text(b.introText, 'el texto principal', 300),
      footerText: text(b.footerText, 'el texto del pie', 160),
      deliveryAddress: text(b.deliveryAddress, 'la dirección de retiro', 300),
      brandImageId: brandImageId || 'seed-brand',
      brandShape: ['square', 'circle', 'rounded'].includes(b.brandShape) ? b.brandShape : 'square',
      whatsapp,
      socials,
    };
    await db.setSetting('site', site);
    res.json(site);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'No se pudo guardar.' });
  }
});
app.put('/api/admin/settings', async (req, res) => {
  const b = req.body || {};
  const pct = (v, label, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw httpError(400, `Revisá ${label} (entre ${min} y ${max}).`);
    return Math.round(n * 100) / 100;
  };
  try {
    const interestPercent = pct(b.interestPercent, 'el interés de cuotas', 0, 200);
    const senaPercent = pct(b.senaPercent, 'la seña', 0, 100);
    await db.setSetting('interestPercent', interestPercent);
    await db.setSetting('senaPercent', senaPercent);
    res.json({ interestPercent, senaPercent });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Panel: catálogo -------------------------------------------------------

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
const installments = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(18, Math.max(1, n)) : 1;
};

app.get('/api/admin/catalog', async (req, res) => res.json(await loadCatalog({ includeInactive: true })));
app.get('/api/admin/stats', async (req, res) => res.set('Cache-Control', 'no-store').json(await stats(req.query.from, req.query.to)));

app.post('/api/admin/products', (req, res) => saveProduct(req, res, null));
app.put('/api/admin/products/:id', (req, res) => saveProduct(req, res, req.params.id));

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
      maxInstallments: installments(b.maxInstallments),
      simulateColor: bool(b.simulateColor),
      fabricPending: bool(b.fabricPending),
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
           color_mode,allows_legs,active,sort,image_ids,max_installments,simulate_color,fabric_pending,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, category=EXCLUDED.category,
           size=EXCLUDED.size, price_cash_cents=EXCLUDED.price_cash_cents, price_credit_cents=EXCLUDED.price_credit_cents,
           allows_orientation=EXCLUDED.allows_orientation, color_mode=EXCLUDED.color_mode, allows_legs=EXCLUDED.allows_legs,
           active=EXCLUDED.active, sort=EXCLUDED.sort, image_ids=EXCLUDED.image_ids,
           max_installments=EXCLUDED.max_installments, simulate_color=EXCLUDED.simulate_color, fabric_pending=EXCLUDED.fabric_pending, updated_at=now()`,
        [productId, f.name, f.description, f.category, f.size, f.priceCash, f.priceCredit, f.allowsOrientation,
          f.colorMode, f.allowsLegs, f.active, f.sort, f.imageIds, f.maxInstallments, f.simulateColor, f.fabricPending]);
      const colors = (await c.query('SELECT id FROM fabric_colors WHERE id = ANY($1)', [f.colorIds])).rows.map((r) => r.id);
      await c.query('DELETE FROM product_fabric_colors WHERE product_id=$1', [productId]);
      for (const cid of colors) await c.query('INSERT INTO product_fabric_colors (product_id, fabric_color_id) VALUES ($1,$2)', [productId, cid]);
      const legs = f.allowsLegs ? (await c.query('SELECT id FROM legs WHERE id = ANY($1)', [f.legIds])).rows.map((r) => r.id) : [];
      await c.query('DELETE FROM product_legs WHERE product_id=$1', [productId]);
      for (const lid of legs) await c.query('INSERT INTO product_legs (product_id, leg_id) VALUES ($1,$2)', [productId, lid]);
    });
    res.json({ id: productId });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'No se pudo guardar el producto.' });
  }
}

app.delete('/api/admin/products/:id', async (req, res) => {
  await db.tx(async (c) => {
    const r = await c.query('SELECT image_ids FROM products WHERE id=$1', [req.params.id]);
    if (r.rows[0] && r.rows[0].image_ids.length) await c.query('DELETE FROM images WHERE id = ANY($1)', [r.rows[0].image_ids]);
    await c.query('DELETE FROM products WHERE id=$1', [req.params.id]);
  });
  res.json({ ok: true });
});

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

// --- Panel: pedidos --------------------------------------------------------

app.get('/api/admin/orders', async (req, res) => {
  const [from, to] = bounds(req.query.from, req.query.to);
  const rows = await db.list(from, to);
  res.set('Cache-Control', 'no-store').json({ orders: rows.map((r) => view(r, { owner: true })) });
});

async function fulfillmentAction(req, res, from, to, reason) {
  const row = await db.byId(req.params.id);
  if (!row) return res.status(404).json({ error: 'Pedido no encontrado.' });
  if (!from.includes(row.fulfillment)) return res.status(409).json({ error: `Este pedido está en estado "${row.fulfillment}".` });
  await db.setFulfillment(row.id, to, reason);
  res.json({ id: row.id, fulfillment: to });
}
const optReason = (req) => optStr((req.body || {}).reason, 300);

app.post('/api/admin/orders/:id/accept', (req, res) => fulfillmentAction(req, res, ['nuevo', 'rechazado'], 'aceptado'));
app.post('/api/admin/orders/:id/deliver', (req, res) => fulfillmentAction(req, res, ['aceptado'], 'entregado'));
app.post('/api/admin/orders/:id/reject', (req, res) =>
  fulfillmentAction(req, res, ['nuevo', 'aceptado'], 'rechazado', optReason(req) || 'Sin motivo indicado'));

app.delete('/api/admin/orders/:id', async (req, res) => {
  const ok = await db.deleteOrder(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Pedido no encontrado.' });
  res.json({ ok: true });
});

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
  .then(async () => {
    if (config.seedLegacy) {
      const r = await seedLegacy();
      console.log('Importación del sitio anterior:', JSON.stringify(r));
    }
    console.log('Ajustes del sitio anterior:', JSON.stringify(await applyLegacyOnce()));
    if (!config.adminPassword) console.warn('ADMIN_PASSWORD no está configurada: el panel no va a permitir ingresar.');
    if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET no configurada: las sesiones del panel se cierran al reiniciar.');
    app.listen(config.port, () => console.log(`Sophie Living en puerto ${config.port} (modo ${config.mode})`));
  })
  .catch((e) => {
    console.error('No se pudo iniciar:', e.code || '', e.message || e);
    process.exit(1);
  });
