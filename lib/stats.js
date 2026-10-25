'use strict';
const db = require('./db');

const q = async (sql) => (await db.pool.query(sql)).rows;

// Todas las métricas del dashboard se calculan en la base.
async function stats() {
  const [totals] = await q(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE created_at >= now() - interval '1 day')::int AS today,
      count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS week,
      count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS month,
      count(*) FILTER (WHERE fulfillment = 'nuevo')::int AS nuevos,
      count(*) FILTER (WHERE fulfillment = 'aceptado')::int AS aceptados,
      count(*) FILTER (WHERE fulfillment = 'entregado')::int AS entregados,
      count(*) FILTER (WHERE fulfillment = 'rechazado')::int AS rechazados,
      coalesce(sum(due_cents) FILTER (WHERE status = 'paid'), 0)::float8 AS cobrado,
      coalesce(sum(due_cents) FILTER (WHERE status = 'paid_test'), 0)::float8 AS cobrado_prueba,
      coalesce(sum(due_cents) FILTER (WHERE status IN ('awaiting_transfer','pending','creating_checkout')
        AND fulfillment <> 'rechazado'), 0)::float8 AS por_cobrar,
      coalesce(avg(total_cents) FILTER (WHERE fulfillment <> 'rechazado'), 0)::float8 AS ticket
    FROM orders`);

  const byStatus = await q(`SELECT status AS name, count(*)::int AS count FROM orders GROUP BY status ORDER BY count DESC`);
  const byProduct = await q(`SELECT coalesce(payload->'product'->>'name','—') AS name, count(*)::int AS count,
    coalesce(sum(total_cents),0)::float8 AS total FROM orders GROUP BY 1 ORDER BY count DESC LIMIT 10`);
  const byPayment = await q(`SELECT coalesce(payload->'selection'->>'payment','—') AS name, count(*)::int AS count
    FROM orders GROUP BY 1 ORDER BY count DESC`);
  const byLeg = await q(`SELECT coalesce(payload->'product'->>'leg','Sin patas') AS name, count(*)::int AS count
    FROM orders GROUP BY 1 ORDER BY count DESC`);
  const byColor = await q(`SELECT name, count(*)::int AS count FROM (
      SELECT payload->'product'->'colorLeft'->>'name' AS name FROM orders
      UNION ALL
      SELECT payload->'product'->'colorRight'->>'name' FROM orders) t
    WHERE name IS NOT NULL GROUP BY name ORDER BY count DESC LIMIT 10`);
  const byDay = await q(`SELECT to_char(date_trunc('day', created_at), 'DD/MM') AS day, count(*)::int AS count
    FROM orders WHERE created_at >= now() - interval '30 days'
    GROUP BY date_trunc('day', created_at) ORDER BY date_trunc('day', created_at)`);

  return { totals, byStatus, byProduct, byPayment, byLeg, byColor, byDay };
}

module.exports = { stats };
