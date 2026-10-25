'use strict';
const crypto = require('crypto');
const env = process.env;
const live = env.MERCADO_PAGO_LIVE_ENABLED === 'true';
const mpToken = live ? env.MERCADO_PAGO_ACCESS_TOKEN : env.MERCADO_PAGO_TEST_ACCESS_TOKEN;

module.exports = {
  live,
  mode: live ? 'live' : 'test',
  mpToken: mpToken || '',
  mpEnabled: !!mpToken,
  webhookSecret: env.MERCADO_PAGO_WEBHOOK_SECRET || '',
  bank: {
    account: env.SOPHIE_BANK_ACCOUNT || '',
    holder: env.SOPHIE_BANK_HOLDER || '',
    bank: env.SOPHIE_BANK_NAME || '',
  },
  transferEnabled: !!(env.SOPHIE_BANK_ACCOUNT && env.SOPHIE_BANK_HOLDER),
  adminPassword: env.ADMIN_PASSWORD || '',
  // Si no se define SESSION_SECRET, las sesiones se cierran al reiniciar el servidor.
  sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  baseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL || '',
  databaseSsl: env.DATABASE_SSL === 'true',
  seedLegacy: env.SEED_LEGACY_CATALOG === 'true',
  port: Number(env.PORT) || 3000,
};
