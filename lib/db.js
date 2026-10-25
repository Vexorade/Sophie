'use strict';
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
});

const SCHEMA = `
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
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
`;

async function init() {
  if (!config.databaseUrl) {
    throw new Error('Falta la variable DATABASE_URL en Render.');
  }
  await pool.query(SCHEMA);
}

async function insert(o) {
  const r = await pool.query(
    `INSERT INTO orders (id, request_id, access_token, channel, mode, status, total_cents, due_cents, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (request_id) DO NOTHING RETURNING id`,
    [o.id, o.requestId, o.accessToken, o.channel, o.mode, o.status, o.total, o.due, o.payload]
  );
  return r.rowCount === 1;
}

const byId = async (id) => (await pool.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0] || null;
const byRequest = async (rid) => (await pool.query('SELECT * FROM orders WHERE request_id=$1', [rid])).rows[0] || null;
const list = async () =>
  (await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100')).rows;

async function setStatus(id, status, mpId) {
  await pool.query(
    'UPDATE orders SET status=$2, mp_id=COALESCE($3, mp_id), updated_at=now() WHERE id=$1',
    [id, status, mpId ?? null]
  );
}

async function setPayload(id, payload, status) {
  await pool.query('UPDATE orders SET payload=$2, status=$3, updated_at=now() WHERE id=$1', [id, payload, status]);
}

module.exports = { init, insert, byId, byRequest, list, setStatus, setPayload, pool };
