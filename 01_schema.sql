-- ============================================================
-- Portfolio Centralizado - Supabase Schema
--
-- Snapshot fiel del schema de produccion (proyecto zxajkzerhpubvtayhapx),
-- regenerado desde el catalogo de Postgres el 2026-09-29.
--
-- Para reconstruir una DB vacia: correr este archivo entero en el SQL Editor.
-- NO es idempotente (no lleva DROP); sobre una DB ya migrada va a fallar,
-- que es intencional para no pisar datos.
-- ============================================================

-- ============================================================
-- ENUMS
-- ============================================================
-- Ingreso/Retiro se agregaron despues de la creacion inicial via
-- ALTER TYPE. El bot los usa para movimientos de efectivo que no son
-- ni compra ni venta (telegram-bot/index.ts).
CREATE TYPE operacion_tipo AS ENUM ('Compra', 'Venta', 'Ingreso', 'Retiro');

-- ============================================================
-- REFERENCE TABLES
-- ============================================================
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

-- ============================================================
-- MAIN TABLES
-- ============================================================
-- Una fila por (activo, broker_id, asset_type_id) en la practica, pero SIN
-- unique constraint: el bot resuelve el alta con un SELECT ... ORDER BY
-- snapshot_date DESC LIMIT 1 y recien ahi decide INSERT vs UPDATE
-- (telegram-bot/index.ts). holdings_current aplica DISTINCT ON como red de
-- seguridad. Si se agrega el unique, hay que revisar ese flujo.
CREATE TABLE holdings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id UUID NOT NULL REFERENCES brokers(id),
  asset_type_id UUID NOT NULL REFERENCES asset_types(id),
  activo TEXT NOT NULL,
  cantidad NUMERIC(18,8) NOT NULL DEFAULT 0,
  costo_promedio NUMERIC(18,4),
  moneda_costo TEXT,
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

-- ============================================================
-- FUTURES CLOSED POSITIONS
-- ============================================================
-- cantidad va en UNIDADES del activo (BTC), no en USDC. precio_salida se
-- resuelve con el cierre de price_history para fecha_cierre.
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

-- ============================================================
-- ALERTAS E INFRAESTRUCTURA
-- ============================================================
CREATE TABLE price_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activo TEXT NOT NULL,
  threshold_usd NUMERIC(18,4) NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('above', 'below')),
  enabled BOOLEAN DEFAULT true,
  last_triggered_date DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Trazabilidad del webhook de Telegram. idx_audit_log_dedup evita procesar
-- dos veces el mismo update de Telegram.
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'telegram',
  chat_id BIGINT,
  message_id BIGINT,
  raw_message TEXT NOT NULL,
  parsed_command JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  caller_ip TEXT
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_holdings_broker ON holdings(broker_id);
CREATE INDEX idx_holdings_activo ON holdings(activo);
CREATE INDEX idx_holdings_snapshot ON holdings(snapshot_date);
CREATE INDEX idx_transactions_broker ON transactions(broker_id);
CREATE INDEX idx_transactions_fecha ON transactions(fecha);
CREATE INDEX idx_transactions_activo ON transactions(activo);
CREATE INDEX idx_price_history_activo_fecha ON price_history(activo, fecha);
CREATE INDEX idx_futures_broker ON futures_closed(broker_id);
CREATE INDEX idx_futures_fecha ON futures_closed(fecha_cierre);
CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_log_ip ON audit_log(caller_ip);
CREATE UNIQUE INDEX idx_audit_log_dedup ON audit_log(chat_id, message_id);

-- ============================================================
-- VIEW: holdings actuales con precios de hoy
--
-- DISTINCT ON (activo, broker_id, asset_type_id) toma la fila mas reciente
-- por posicion. OJO: la version anterior de esta vista filtraba por
-- MAX(snapshot_date) global, lo que hacia desaparecer del dashboard toda
-- posicion con una fecha vieja. No volver a eso.
--
-- Para CEDEARs (ratio != 0) el precio de mercado viene en ARS y se divide
-- por el ratio para llevarlo a USD.
-- ============================================================
CREATE VIEW holdings_current AS
SELECT DISTINCT ON (h.activo, h.broker_id, h.asset_type_id)
  h.id,
  b.name AS broker,
  at.name AS tipo,
  h.activo,
  h.cantidad,
  h.costo_promedio,
  h.moneda_costo,
  h.ratio,
  h.notas,
  CASE WHEN at.name = 'CEDEAR' AND h.ratio IS NOT NULL AND h.ratio > 0
       THEN COALESCE((ph.precio_usd / h.ratio)::NUMERIC(18,4), h.precio_usd)
       ELSE COALESCE(ph.precio_usd, h.precio_usd) END AS precio_usd,
  CASE WHEN at.name = 'CEDEAR' AND h.ratio IS NOT NULL AND h.ratio > 0
       THEN COALESCE((ph.precio_ars / h.ratio)::NUMERIC(18,4), h.precio_ars)
       ELSE COALESCE(ph.precio_ars, h.precio_ars) END AS precio_ars,
  CASE WHEN at.name = 'CEDEAR' AND h.ratio IS NOT NULL AND h.ratio > 0
       THEN COALESCE((h.cantidad * (ph.precio_usd / h.ratio))::NUMERIC(18,4), h.valor_usd)
       ELSE COALESCE((h.cantidad * ph.precio_usd)::NUMERIC(18,4), h.valor_usd) END AS valor_usd,
  CASE WHEN at.name = 'CEDEAR' AND h.ratio IS NOT NULL AND h.ratio > 0
       THEN COALESCE((h.cantidad * (ph.precio_ars / h.ratio))::NUMERIC(18,4), h.valor_ars)
       ELSE COALESCE((h.cantidad * ph.precio_ars)::NUMERIC(18,4), h.valor_ars) END AS valor_ars,
  h.invertido_usd,
  CASE WHEN at.name = 'CEDEAR' AND h.ratio IS NOT NULL AND h.ratio > 0
       THEN COALESCE((h.cantidad * (ph.precio_usd / h.ratio) - h.invertido_usd)::NUMERIC(18,4), h.pnl_usd)
       ELSE COALESCE((h.cantidad * ph.precio_usd - h.invertido_usd)::NUMERIC(18,4), h.pnl_usd) END AS pnl_usd,
  CASE WHEN h.invertido_usd > 0
       THEN ((CASE WHEN at.name = 'CEDEAR' AND h.ratio IS NOT NULL AND h.ratio > 0
                   THEN COALESCE((h.cantidad * (ph.precio_usd / h.ratio))::NUMERIC(18,4), h.valor_usd)
                   ELSE COALESCE((h.cantidad * ph.precio_usd)::NUMERIC(18,4), h.valor_usd) END
             - h.invertido_usd) / h.invertido_usd * 100)::NUMERIC(10,4)
       ELSE h.pnl_pct END AS pnl_pct,
  h.pnl_realizado_usd,
  h.snapshot_date
FROM holdings h
JOIN brokers b ON h.broker_id = b.id
JOIN asset_types at ON h.asset_type_id = at.id
LEFT JOIN price_history ph ON h.activo = ph.activo AND ph.fecha = CURRENT_DATE
ORDER BY h.activo, h.broker_id, h.asset_type_id, h.snapshot_date DESC;

-- ============================================================
-- VIEW: resumen de cartera
-- liquidity = USD en CASH + USDC en CRYPTO. NULLIF evita division por cero
-- con una cartera vacia.
-- ============================================================
CREATE VIEW portfolio_summary AS
SELECT
  COUNT(*) AS total_activos,
  SUM(valor_usd) AS valor_total_usd,
  SUM(invertido_usd) AS invertido_total_usd,
  SUM(pnl_usd) AS pnl_total_usd,
  CASE WHEN SUM(invertido_usd) > 0
       THEN ROUND(SUM(pnl_usd) / SUM(invertido_usd) * 100, 4)
       ELSE 0 END AS retorno_pct,
  SUM(CASE WHEN tipo IN ('CASH', 'CRYPTO') AND activo IN ('USD', 'USDC')
           THEN valor_usd ELSE 0 END) AS liquidez_usd
FROM holdings_current;

-- ============================================================
-- VIEW: concentracion (activos > 5% de la cartera)
-- ============================================================
CREATE VIEW concentration_alerts AS
SELECT
  h.activo,
  h.broker,
  h.tipo,
  h.valor_usd,
  ROUND(h.valor_usd / NULLIF(ps.valor_total_usd, 0) * 100, 1) AS pct_portfolio,
  CASE
    WHEN h.valor_usd / NULLIF(ps.valor_total_usd, 0) >= 0.20 THEN 'CRITICAL'
    WHEN h.valor_usd / NULLIF(ps.valor_total_usd, 0) >= 0.10 THEN 'WARNING'
    ELSE 'OK'
  END AS alert_level
FROM holdings_current h, portfolio_summary ps
WHERE h.valor_usd / NULLIF(ps.valor_total_usd, 0) >= 0.05
ORDER BY h.valor_usd DESC;

-- ============================================================
-- ROW LEVEL SECURITY
--
-- Las tablas de la cartera se leen desde el dashboard con la service role
-- (dashboard/index.ts), pero quedan abiertas a clientes autenticados.
-- price_alerts y audit_log son service_role ONLY: no exponer por error.
-- ============================================================
ALTER TABLE brokers ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE config ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE futures_closed ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "all_access_brokers" ON brokers FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "all_access_asset_types" ON asset_types FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "all_access_holdings" ON holdings FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "all_access_transactions" ON transactions FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "all_access_config" ON config FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "all_access_price_history" ON price_history FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "all_access_futures" ON futures_closed FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "service_role_only_price_alerts" ON price_alerts FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_only" ON audit_log FOR ALL USING (auth.role() = 'service_role');
