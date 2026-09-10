-- ============================================================
-- Portfolio Centralizado - Supabase Migration
-- Run this first in SQL Editor
-- ============================================================

-- ENUMS
CREATE TYPE operacion_tipo AS ENUM ('Compra', 'Venta');

-- REFERENCE TABLES
CREATE TABLE brokers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE asset_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- MAIN TABLES
CREATE TABLE holdings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id UUID NOT NULL REFERENCES brokers(id),
  asset_type_id UUID NOT NULL REFERENCES asset_types(id),
  activo TEXT NOT NULL,
  cantidad NUMERIC(18,8) NOT NULL DEFAULT 0,
  costo_promedio NUMERIC(18,4),
  moneda_costo TEXT DEFAULT 'USD',
  ratio NUMERIC(18,4),
  notas TEXT,
  precio_usd NUMERIC(18,4),
  precio_ars NUMERIC(18,4),
  valor_usd NUMERIC(18,4),
  valor_ars NUMERIC(18,4),
  invertido_usd NUMERIC(18,4),
  pnl_usd NUMERIC(18,4),
  pnl_pct NUMERIC(10,4),
  pnl_realizado_usd NUMERIC(18,4),
  snapshot_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id UUID NOT NULL REFERENCES brokers(id),
  asset_type_id UUID NOT NULL REFERENCES asset_types(id),
  activo TEXT NOT NULL,
  fecha DATE NOT NULL,
  operacion operacion_tipo NOT NULL,
  cantidad NUMERIC(18,8) NOT NULL,
  precio_unitario_usd NUMERIC(18,4),
  total_usd NUMERIC(18,4),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clave TEXT NOT NULL UNIQUE,
  valor TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activo TEXT NOT NULL,
  precio_usd NUMERIC(18,4),
  precio_ars NUMERIC(18,4),
  fuente TEXT,
  fecha DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(activo, fecha)
);

-- INDEXES
CREATE INDEX idx_holdings_broker ON holdings(broker_id);
CREATE INDEX idx_holdings_activo ON holdings(activo);
CREATE INDEX idx_holdings_snapshot ON holdings(snapshot_date);
CREATE INDEX idx_transactions_broker ON transactions(broker_id);
CREATE INDEX idx_transactions_fecha ON transactions(fecha);
CREATE INDEX idx_transactions_activo ON transactions(activo);
CREATE INDEX idx_price_history_activo_fecha ON price_history(activo, fecha);

-- VIEW: current holdings with live prices
CREATE VIEW holdings_current AS
SELECT
  h.id,
  b.name AS broker,
  at.name AS tipo,
  h.activo,
  h.cantidad,
  h.costo_promedio,
  h.moneda_costo,
  h.ratio,
  h.notas,
  COALESCE(ph.precio_usd, h.precio_usd) AS precio_usd,
  COALESCE(ph.precio_ars, h.precio_ars) AS precio_ars,
  COALESCE(h.cantidad * ph.precio_usd, h.valor_usd) AS valor_usd,
  COALESCE(h.cantidad * ph.precio_ars, h.valor_ars) AS valor_ars,
  h.invertido_usd,
  COALESCE(h.cantidad * ph.precio_usd - h.invertido_usd, h.pnl_usd) AS pnl_usd,
  CASE
    WHEN h.invertido_usd > 0
    THEN ((COALESCE(h.cantidad * ph.precio_usd, h.valor_usd) - h.invertido_usd) / h.invertido_usd) * 100
    ELSE h.pnl_pct
  END AS pnl_pct,
  h.pnl_realizado_usd,
  h.snapshot_date
FROM holdings h
JOIN brokers b ON h.broker_id = b.id
JOIN asset_types at ON h.asset_type_id = at.id
LEFT JOIN price_history ph ON h.activo = ph.activo AND ph.fecha = CURRENT_DATE
WHERE h.snapshot_date = (SELECT COALESCE(MAX(snapshot_date), CURRENT_DATE) FROM holdings);

-- VIEW: portfolio summary
CREATE VIEW portfolio_summary AS
SELECT
  COUNT(*) AS total_activos,
  SUM(valor_usd) AS valor_total_usd,
  SUM(invertido_usd) AS invertido_total_usd,
  SUM(pnl_usd) AS pnl_total_usd,
  CASE
    WHEN SUM(invertido_usd) > 0
    THEN (SUM(pnl_usd) / SUM(invertido_usd)) * 100
    ELSE 0
  END AS retorno_pct,
  SUM(CASE WHEN at.name IN ('CASH', 'CRYPTO') AND h.activo IN ('USD', 'USDC') THEN h.valor_usd ELSE 0 END) AS liquidez_usd,
  MAX(CASE WHEN at.name = 'CASH' AND h.activo = 'USD' THEN h.valor_usd ELSE 0 END) AS efectivo_usd
FROM holdings_current h
JOIN asset_types at ON h.tipo = at.name;

-- VIEW: concentration (assets > 10% of portfolio)
CREATE VIEW concentration_alerts AS
SELECT
  h.activo,
  h.broker,
  h.tipo,
  h.valor_usd,
  ROUND(h.valor_usd / ps.valor_total_usd * 100, 1) AS pct_portfolio,
  CASE
    WHEN h.valor_usd / ps.valor_total_usd >= 0.20 THEN 'CRITICAL'
    WHEN h.valor_usd / ps.valor_total_usd >= 0.10 THEN 'WARNING'
    ELSE 'OK'
  END AS alert_level
FROM holdings_current h, portfolio_summary ps
WHERE h.valor_usd / ps.valor_total_usd >= 0.05
ORDER BY h.valor_usd DESC;

-- FUTURES CLOSED POSITIONS
CREATE TABLE futures_closed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id UUID NOT NULL REFERENCES brokers(id),
  activo TEXT NOT NULL,
  direccion TEXT NOT NULL CHECK (direccion IN ('LONG', 'SHORT')),
  cantidad NUMERIC(18,8) NOT NULL,
  precio_entrada NUMERIC(18,4) NOT NULL,
  precio_salida NUMERIC(18,8) NOT NULL,
  pnl_usd NUMERIC(18,4) NOT NULL,
  fecha_cierre DATE NOT NULL,
  notas TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_futures_broker ON futures_closed(broker_id);
CREATE INDEX idx_futures_fecha ON futures_closed(fecha_cierre);

-- ROW LEVEL SECURITY
ALTER TABLE brokers ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE config ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE futures_closed ENABLE ROW LEVEL SECURITY;

CREATE POLICY "all_access_brokers" ON brokers FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "all_access_asset_types" ON asset_types FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "all_access_holdings" ON holdings FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "all_access_transactions" ON transactions FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "all_access_config" ON config FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "all_access_price_history" ON price_history FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "all_access_futures" ON futures_closed FOR ALL USING (auth.role() = 'authenticated');
