-- ============================================================
-- Migration Entrega 4: Notificações via WhatsApp
--  - Telefone normalizado (E.164) + consentimento LGPD nos responsáveis
--  - Preferências por tipo de aviso/canal
--  - Fila persistente whatsapp_jobs (Transactional Outbox, separada de email_jobs
--    para não alterar o contrato da fila de e-mail já em produção/testes)
-- Requer MySQL 8+ (JSON, SKIP LOCKED).
-- ============================================================

-- 1. Telefone normalizado + consentimento (LGPD)
ALTER TABLE pais
  ADD COLUMN telefone_e164         VARCHAR(16) NULL COMMENT 'Ex: +5511999998888',
  ADD COLUMN whatsapp_optin        TINYINT(1)  NOT NULL DEFAULT 0,
  ADD COLUMN whatsapp_optin_em     DATETIME    NULL,
  ADD COLUMN whatsapp_optin_origem VARCHAR(30) NULL COMMENT 'painel_pais | secretaria',
  ADD COLUMN whatsapp_optout_em    DATETIME    NULL,
  ADD KEY idx_pais_telefone_e164 (telefone_e164);

-- 2. Preferências por tipo de aviso (ausência de linha = ativo)
CREATE TABLE IF NOT EXISTS notificacao_preferencias (
  pai_id INT NOT NULL,
  tipo   VARCHAR(40) NOT NULL COMMENT 'falta | justificativa | evasao | resumo_mensal',
  canal  ENUM('email','whatsapp') NOT NULL,
  ativo  TINYINT(1) NOT NULL DEFAULT 1,
  atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (pai_id, tipo, canal),
  CONSTRAINT fk_pref_pai FOREIGN KEY (pai_id) REFERENCES pais(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 3. Fila de WhatsApp
CREATE TABLE IF NOT EXISTS whatsapp_jobs (
  id INT NOT NULL AUTO_INCREMENT,
  usuario_id INT NOT NULL COMMENT 'Usuário responsável (destinatário)',
  aluno_id   INT NOT NULL,
  destinatario VARCHAR(16) NOT NULL COMMENT 'Telefone E.164',
  template  VARCHAR(60) NOT NULL COMMENT 'Nome do template (Meta) / chave em templates.js',
  variaveis JSON NOT NULL COMMENT 'Parâmetros do template, na ordem',
  mensagem  TEXT NOT NULL COMMENT 'Texto renderizado (providers não-oficiais / auditoria)',
  tipo_notificacao VARCHAR(50) NOT NULL DEFAULT 'falta',
  data_referencia  DATE NOT NULL,
  status ENUM('PENDING','PROCESSING','RETRY','SENT','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  tentativas     INT NOT NULL DEFAULT 0,
  max_tentativas INT NOT NULL DEFAULT 5,
  ultimo_erro TEXT DEFAULT NULL,
  criado_em     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processado_em DATETIME DEFAULT NULL,
  proxima_tentativa_em DATETIME DEFAULT NULL,
  enviar_apos   DATETIME DEFAULT NULL COMMENT 'Janela de correção: não envia antes disso',
  provider        VARCHAR(20)  DEFAULT NULL,
  provider_msg_id VARCHAR(128) DEFAULT NULL,
  status_entrega ENUM('sent','delivered','read','failed') DEFAULT NULL COMMENT 'Atualizado via webhook',
  entregue_em DATETIME DEFAULT NULL,
  lido_em     DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_wa_jobs_fila (status, enviar_apos, proxima_tentativa_em),
  KEY idx_wa_jobs_usuario (usuario_id),
  KEY idx_wa_jobs_provider_msg (provider_msg_id),
  UNIQUE KEY uq_wa_jobs_idempotencia (aluno_id, tipo_notificacao, data_referencia),
  CONSTRAINT fk_wa_jobs_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
  CONSTRAINT fk_wa_jobs_aluno   FOREIGN KEY (aluno_id)   REFERENCES alunos(id)   ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
