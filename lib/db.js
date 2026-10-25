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
