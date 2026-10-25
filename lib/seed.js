'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { sniffImage } = require('./images');

// Importa el catálogo del sitio anterior. Solo corre si la tabla de productos está vacía.
async function seedLegacy() {
  const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM products');
  if (rows[0].n > 0) return { skipped: true };

  const root = path.join(__dirname, '..', 'seed');
  const data = JSON.parse(fs.readFileSync(path.join(root, 'legacy.json'), 'utf8'));
  const imgId = (file) => 'seed-' + file.replace(/\.webp$/, '');

  // Muestras de tela: se descargan de los sitios originales. Si alguna falla, queda sin foto.
  const swatches = new Map();
  for (const f of data.fabrics) {
    for (const col of f.colors) {
      try {
        const res = await fetch(col.url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        const mime = sniffImage(buf);
        if (mime) swatches.set(col.id, { buf, mime });
      } catch { /* sin muestra */ }
    }
  }

  await db.tx(async (c) => {
    const putImage = (id, buf, mime) => c.query(
      'INSERT INTO images (id, mime, data, bytes) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
      [id, mime, buf, buf.length]);

    const files = new Set();
    for (const p of data.products) p.images.forEach((f) => files.add(f));
    data.legs.forEach((l) => files.add(l.image));
    for (const f of files) await putImage(imgId(f), fs.readFileSync(path.join(root, 'images', f)), 'image/webp');

    for (const [i, l] of data.legs.entries()) {
      await c.query(
        'INSERT INTO legs (id, name, image_id, extra_cents, active, sort) VALUES ($1,$2,$3,$4,true,$5) ON CONFLICT (id) DO NOTHING',
        [l.id, l.name, imgId(l.image), l.extra, i]);
    }

    for (const [i, f] of data.fabrics.entries()) {
      await c.query(
        'INSERT INTO fabrics (id, name, surcharge_percent, active, sort) VALUES ($1,$2,$3,true,$4) ON CONFLICT (id) DO NOTHING',
        [f.id, f.name, f.surcharge, i]);
      for (const [j, col] of f.colors.entries()) {
        let imageId = null;
        const sw = swatches.get(col.id);
        if (sw) { imageId = 'seed-' + col.id; await putImage(imageId, sw.buf, sw.mime); }
        await c.query(
          'INSERT INTO fabric_colors (id, fabric_id, name, image_id, active, sort) VALUES ($1,$2,$3,$4,true,$5) ON CONFLICT (id) DO NOTHING',
          [col.id, f.id, col.name, imageId, j]);
      }
    }

    for (const [i, p] of data.products.entries()) {
      const category = /Esquinero/.test(p.name) ? 'Esquineros' : 'Sofás';
      await c.query(
        `INSERT INTO products (id, name, description, category, size, price_cash_cents, price_credit_cents,
           allows_orientation, color_mode, allows_legs, active, sort, image_ids, max_installments)
         VALUES ($1,$2,'',$3,$4,$5,$6,true,'single',true,$7,$8,$9,18) ON CONFLICT (id) DO NOTHING`,
        [p.id, p.name, category, p.size, p.priceCash, p.priceCredit, p.active, i, p.images.map(imgId)]);
      for (const cid of p.colorIds) {
        await c.query('INSERT INTO product_fabric_colors (product_id, fabric_color_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.id, cid]);
      }
      for (const lid of p.legIds) {
        await c.query('INSERT INTO product_legs (product_id, leg_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.id, lid]);
      }
    }
  });
  return { imported: data.products.length };
}

module.exports = { seedLegacy };
