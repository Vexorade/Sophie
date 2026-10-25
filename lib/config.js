'use strict';
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
  adminUser: env.ADMIN_USER || 'admin',
  adminPassword: env.ADMIN_PASSWORD || '',
  baseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL || '',
  databaseSsl: env.DATABASE_SSL === 'true',
  port: Number(env.PORT) || 3000,
};
