CREATE TABLE IF NOT EXISTS tecnicos_eventos (
  id               BIGSERIAL PRIMARY KEY,
  message_id       TEXT UNIQUE,
  chat_id          TEXT NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tecnico_numero   TEXT,
  tecnico_nome     TEXT,
  raw_text         TEXT,
  tipo             TEXT,
  cliente_nome     TEXT,
  cliente_cpf      TEXT,
  cliente_login    TEXT,
  equipamento      TEXT,
  fabricante       TEXT,
  modelo           TEXT,
  serial           TEXT,
  mac              TEXT,
  equip_anterior   TEXT,
  observacoes      TEXT,
  foto_filename    TEXT,
  foto_mime        TEXT,
  ai_raw_json      JSONB,
  gesprov_cliente  JSONB
);

CREATE INDEX IF NOT EXISTS idx_tecnicos_eventos_received ON tecnicos_eventos (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_tecnicos_eventos_serial   ON tecnicos_eventos (serial);
CREATE INDEX IF NOT EXISTS idx_tecnicos_eventos_cliente  ON tecnicos_eventos (cliente_nome);
CREATE INDEX IF NOT EXISTS idx_tecnicos_eventos_tipo     ON tecnicos_eventos (tipo);
