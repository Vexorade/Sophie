'use strict';
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  price_cash_cents INTEGER NOT NULL,
  price_credit_cents INTEGER NOT NULL,
  allows_orientation BOOLEAN NOT NULL DEFAULT false,
  color_mode TEXT NOT NULL DEFAULT 'single' CHECK (color_mode IN ('single','split')),
  allows_legs BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  sort INTEGER NOT NULL DEFAULT 0,
  image_ids TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fabrics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  surcharge_percent INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS fabric_colors (
  id TEXT PRIMARY KEY,
  fabric_id TEXT NOT NULL REFERENCES fabrics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  image_id TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS legs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image_id TEXT,
  extra_cents INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS product_fabric_colors (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  fabric_color_id TEXT NOT NULL REFERENCES fabric_colors(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, fabric_color_id)
);
CREATE TABLE IF NOT EXISTS product_legs (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  leg_id TEXT NOT NULL REFERENCES legs(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, leg_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL,
  access_token TEXT NOT NULL,
  channel TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  due_cents INTEGER NOT NULL,
  mp_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment TEXT NOT NULL DEFAULT 'nuevo';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reject_reason TEXT;
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);
ALTER TABLE products ADD COLUMN IF NOT EXISTS max_installments INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE images ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE fabrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE fabric_colors ENABLE ROW LEVEL SECURITY;
ALTER TABLE legs ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_fabric_colors ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_legs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
`;

const DEFAULT_SETTINGS = { interestPercent: 0, senaPercent: 50 };

async function init() {
  if (!config.databaseUrl) throw new Error('Falta la variable DATABASE_URL en Render.');
  await pool.query(SCHEMA);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(value)]);
  }
}

async function getSettings() {
  const rows = (await pool.query('SELECT key, value FROM settings')).rows;
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',
    [key, JSON.stringify(value)]
  );
}

async function deleteOrder(id) {
  const r = await pool.query('DELETE FROM orders WHERE id=$1', [id]);
  return r.rowCount === 1;
}

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

async function insertOrder(o) {
  const r = await pool.query(
    `INSERT INTO orders (id, request_id, access_token, channel, mode, status, total_cents, due_cents, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (request_id) DO NOTHING RETURNING id`,
    [o.id, o.requestId, o.accessToken, o.channel, o.mode, o.status, o.total, o.due, o.payload]
  );
  return r.rowCount === 1;
}

const byId = async (id) => (await pool.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0] || null;
const byRequest = async (rid) => (await pool.query('SELECT * FROM orders WHERE request_id=$1', [rid])).rows[0] || null;
const list = async (from, to) => (await pool.query(
  `SELECT * FROM orders
   WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
     AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
   ORDER BY created_at DESC LIMIT 1000`, [from, to])).rows;

async function setStatus(id, status, mpId) {
  await pool.query(
    'UPDATE orders SET status=$2, mp_id=COALESCE($3, mp_id), updated_at=now() WHERE id=$1',
    [id, status, mpId ?? null]
  );
}

async function setPayload(id, payload, status) {
  await pool.query('UPDATE orders SET payload=$2, status=$3, updated_at=now() WHERE id=$1', [id, payload, status]);
}

async function setFulfillment(id, fulfillment, reason) {
  await pool.query(
    'UPDATE orders SET fulfillment=$2, reject_reason=$3, updated_at=now() WHERE id=$1',
    [id, fulfillment, reason ?? null]
  );
}

module.exports = { pool, tx, init, insertOrder, byId, byRequest, list, setStatus, setPayload, setFulfillment, getSettings, setSetting, deleteOrder, DEFAULT_SETTINGS };
