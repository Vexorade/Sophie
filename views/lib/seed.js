'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { sniffImage } = require('./images');

const ROOT = path.join(__dirname, '..', 'seed');
const readLegacy = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'legacy.json'), 'utf8'));
const imgId = (file) => 'seed-' + file.replace(/\.webp$/, '');

// Descarga las muestras de tela de los sitios originales. Si una no carga, queda sin foto.
async function fetchSwatches(data) {
  const out = new Map();
  for (const f of data.fabrics) {
    for (const col of f.colors) {
      try {
        const res = await fetch(col.url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        const mime = sniffImage(buf);
        if (mime) out.set(col.id, { buf, mime });
      } catch { /* sin muestra */ }
    }
  }
  return out;
}

// Importa el catálogo del sitio anterior. Solo corre si no hay productos.
async function seedLegacy() {
  const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM products');
  if (rows[0].n > 0) return { skipped: true };
  const data = readLegacy();
  const swatches = await fetchSwatches(data);

  await db.tx(async (c) => {
    const putImage = (id, buf, mime) => c.query(
      'INSERT INTO images (id, mime, data, bytes) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING', [id, mime, buf, buf.length]);
    const files = new Set();
    for (const p of data.products) p.images.forEach((f) => files.add(f));
    data.legs.forEach((l) => files.add(l.image));
    for (const f of files) await putImage(imgId(f), fs.readFileSync(path.join(ROOT, 'images', f)), 'image/webp');
    await putImage('seed-brand', fs.readFileSync(path.join(ROOT, 'images', 'brand.webp')), 'image/webp');

    for (const [i, l] of data.legs.entries()) {
      await c.query('INSERT INTO legs (id, name, image_id, extra_cents, active, sort) VALUES ($1,$2,$3,$4,true,$5) ON CONFLICT (id) DO NOTHING',
        [l.id, l.name, imgId(l.image), l.extra, i]);
    }
    for (const [i, f] of data.fabrics.entries()) {
      await c.query('INSERT INTO fabrics (id, name, surcharge_percent, active, sort) VALUES ($1,$2,$3,true,$4) ON CONFLICT (id) DO NOTHING',
        [f.id, f.name, f.surcharge, i]);
      for (const [j, col] of f.colors.entries()) {
        let imageId = null;
        const sw = swatches.get(col.id);
        if (sw) { imageId = 'seed-' + col.id; await putImage(imageId, sw.buf, sw.mime); }
        await c.query('INSERT INTO fabric_colors (id, fabric_id, name, image_id, active, sort, hex) VALUES ($1,$2,$3,$4,true,$5,$6) ON CONFLICT (id) DO NOTHING',
          [col.id, f.id, col.name, imageId, j, col.hex || null]);
      }
    }
    for (const [i, p] of data.products.entries()) {
      await c.query(
        `INSERT INTO products (id, name, description, category, size, price_cash_cents, price_credit_cents,
           allows_orientation, color_mode, allows_legs, active, sort, image_ids, max_installments, simulate_color, fabric_pending)
         VALUES ($1,$2,'',$3,$4,$5,$6,$7,'single',true,$8,$9,$10,18,$11,$12) ON CONFLICT (id) DO NOTHING`,
        [p.id, p.name, /Esquinero/.test(p.name) ? 'Esquineros' : 'Sofás', p.size, p.priceCash, p.priceCredit,
          p.allowsOrientation, p.active, i, p.images.map(imgId), p.simulateColor, p.fabricPending]);
      for (const cid of p.colorIds) await c.query('INSERT INTO product_fabric_colors (product_id, fabric_color_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.id, cid]);
      for (const lid of p.legIds) await c.query('INSERT INTO product_legs (product_id, leg_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.id, lid]);
    }
  });
  return { imported: data.products.length };
}

// Ajustes de los productos del sitio anterior para bases que ya fueron importadas.
// Se aplican una sola vez y después no pisan lo que cambie el administrador.
async function applyLegacyOnce() {
  const done = (await db.getSettings()).legacy_v2;
  if (done) return { skipped: true };
  const data = readLegacy();
  await db.tx(async (c) => {
    for (const p of data.products) {
      await c.query('UPDATE products SET allows_orientation=$2, simulate_color=$3, fabric_pending=$4 WHERE id=$1',
        [p.id, p.allowsOrientation, p.simulateColor, p.fabricPending]);
      if (p.fabricPending) await c.query('UPDATE products SET active=true WHERE id=$1', [p.id]);
    }
    for (const f of data.fabrics) for (const col of f.colors) {
      if (col.hex) await c.query('UPDATE fabric_colors SET hex=$2 WHERE id=$1', [col.id, col.hex]);
    }
    const brand = fs.readFileSync(path.join(ROOT, 'images', 'brand.webp'));
    await c.query('INSERT INTO images (id, mime, data, bytes) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING', ['seed-brand', 'image/webp', brand, brand.length]);
    for (const n of ['4085', '4090', '4094', '4596']) {
      const buf = fs.readFileSync(path.join(ROOT, 'images', `sofa-${n}.webp`));
      await c.query('UPDATE images SET data=$2, bytes=$3, mime=$4 WHERE id=$1 AND bytes<>$3', ['seed-sofa-' + n, buf, buf.length, 'image/webp']);
    }
    await c.query("INSERT INTO settings (key, value) VALUES ('legacy_v2', 'true') ON CONFLICT (key) DO UPDATE SET value='true'");
  });
  return { applied: true };
}

module.exports = { seedLegacy, applyLegacyOnce };
