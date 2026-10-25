'use strict';
const db = require('./db');

const q = async (sql, params = []) => (await db.pool.query(sql, params)).rows;
const TZ = 'America/Argentina/Buenos_Aires';

// Convierte fechas YYYY-MM-DD (hora de Argentina) en límites [desde, hasta).
function bounds(from, to) {
  const ok = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const f = ok(from) ? new Date(`${from}T00:00:00-03:00`) : null;
  let t = null;
  if (ok(to)) t = new Date(new Date(`${to}T00:00:00-03:00`).getTime() + 86400000);
  return [f ? f.toISOString() : null, t ? t.toISOString() : null];
}

const W = `($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
  AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)`;

async function stats(from, to) {
  const [f, t] = bounds(from, to);
  const p = [f, t];
  const [totals] = await q(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE created_at >= now() - interval '1 day')::int AS today,
      count(*) FILTER (WHERE fulfillment = 'nuevo')::int AS nuevos,
      count(*) FILTER (WHERE fulfillment = 'aceptado')::int AS aceptados,
      count(*) FILTER (WHERE fulfillment = 'entregado')::int AS entregados,
      count(*) FILTER (WHERE fulfillment = 'rechazado')::int AS rechazados,
      coalesce(sum(due_cents) FILTER (WHERE status = 'paid'), 0)::float8 AS cobrado,
      coalesce(sum(due_cents) FILTER (WHERE status = 'paid_test'), 0)::float8 AS cobrado_prueba,
      coalesce(sum(due_cents) FILTER (WHERE status IN ('awaiting_transfer','pending','creating_checkout')
        AND fulfillment <> 'rechazado'), 0)::float8 AS por_cobrar,
      coalesce(sum(total_cents) FILTER (WHERE fulfillment <> 'rechazado'), 0)::float8 AS vendido,
      coalesce(avg(total_cents) FILTER (WHERE fulfillment <> 'rechazado'), 0)::float8 AS ticket
    FROM orders WHERE ${W}`, p);

  const grp = (expr) => q(`SELECT ${expr} AS name, count(*)::int AS count, coalesce(sum(total_cents),0)::float8 AS total
    FROM orders WHERE ${W} GROUP BY 1 ORDER BY count DESC LIMIT 12`, p);

  const byStatus = await grp('status');
  const byProduct = await grp(`coalesce(payload->'product'->>'name','—')`);
  const byPayment = await grp(`coalesce(payload->'selection'->>'payment','—')`);
  const byLeg = await grp(`coalesce(payload->'product'->>'leg','Sin patas')`);
  const byColor = await q(`SELECT name, count(*)::int AS count FROM (
      SELECT payload->'product'->'colorLeft'->>'name' AS name, created_at FROM orders
      UNION ALL
      SELECT payload->'product'->'colorRight'->>'name', created_at FROM orders) t
    WHERE name IS NOT NULL AND ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
      AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
    GROUP BY name ORDER BY count DESC LIMIT 12`, p);

  // Por día: si no hay rango, últimos 30 días.
  const dayFrom = f || new Date(Date.now() - 30 * 86400000).toISOString();
  const byDay = await q(`SELECT to_char(date_trunc('day', created_at AT TIME ZONE '${TZ}'), 'DD/MM') AS day,
      count(*)::int AS count, coalesce(sum(total_cents),0)::float8 AS total
    FROM orders WHERE created_at >= $1::timestamptz AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
    GROUP BY date_trunc('day', created_at AT TIME ZONE '${TZ}') ORDER BY date_trunc('day', created_at AT TIME ZONE '${TZ}')`,
  [dayFrom, t]);

  return { totals, byStatus, byProduct, byPayment, byLeg, byColor, byDay };
}

module.exports = { stats, bounds };
