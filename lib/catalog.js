'use strict';
const db = require('./db');

const q = async (sql) => (await db.pool.query(sql)).rows;

// Carga el catálogo completo en pocas consultas.
// includeInactive=false devuelve solo lo que ve el cliente.
async function loadCatalog({ includeInactive = false } = {}) {
  const on = (col) => (includeInactive ? '' : `WHERE ${col}`);
  const fabrics = await q(`SELECT * FROM fabrics ${on('active')} ORDER BY sort, name`);
  const colors = await q(`SELECT * FROM fabric_colors ${on('active')} ORDER BY sort, name`);
  const legs = await q(`SELECT * FROM legs ${on('active')} ORDER BY sort, name`);
  const products = await q(`SELECT * FROM products ${on('active')} ORDER BY sort, name`);
  const pfc = await q('SELECT * FROM product_fabric_colors');
  const pl = await q('SELECT * FROM product_legs');

  const fabricMap = new Map(fabrics.map((f) => [f.id, f]));
  const colorMap = new Map();
  for (const c of colors) {
    const f = fabricMap.get(c.fabric_id);
    if (!f) continue;
    colorMap.set(c.id, {
      id: c.id, name: c.name, active: c.active,
      fabricId: f.id, fabric: f.name, surcharge: f.surcharge_percent,
      imageId: c.image_id,
    });
  }
  const legMap = new Map(legs.map((l) => [l.id, {
    id: l.id, name: l.name, active: l.active, imageId: l.image_id, extra: Number(l.extra_cents),
  }]));

  return {
    products: products.map((p) => ({
      id: p.id, name: p.name, description: p.description, category: p.category, size: p.size,
      priceCash: Number(p.price_cash_cents), priceCredit: Number(p.price_credit_cents),
      allowsOrientation: p.allows_orientation, colorMode: p.color_mode, allowsLegs: p.allows_legs,
      active: p.active, sort: p.sort, imageIds: p.image_ids,
      colors: pfc.filter((x) => x.product_id === p.id).map((x) => colorMap.get(x.fabric_color_id)).filter(Boolean),
      legs: p.allows_legs
        ? pl.filter((x) => x.product_id === p.id).map((x) => legMap.get(x.leg_id)).filter(Boolean)
        : [],
    })),
    fabrics: fabrics.map((f) => ({
      id: f.id, name: f.name, surcharge: f.surcharge_percent, active: f.active, sort: f.sort,
      colors: colors.filter((c) => c.fabric_id === f.id).map((c) => ({
        id: c.id, name: c.name, active: c.active, imageId: c.image_id,
      })),
    })),
    legs: legs.map((l) => ({
      id: l.id, name: l.name, active: l.active, imageId: l.image_id, extra: Number(l.extra_cents), sort: l.sort,
    })),
  };
}

module.exports = { loadCatalog };
