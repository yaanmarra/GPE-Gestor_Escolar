-- ============================================================
-- Migration Fase 2: Tabela email_jobs (Transactional Outbox)
-- Garante que notificações de email não se percam se o Node morrer
-- ============================================================

CREATE TABLE IF NOT EXISTS email_jobs (
  id INT NOT NULL AUTO_INCREMENT,
  usuario_id INT NOT NULL COMMENT 'ID do usuário destinatário (pai/responsável)',
  aluno_id INT NOT NULL COMMENT 'ID do aluno relacionado à notificação',
  destinatario VARCHAR(100) NOT NULL COMMENT 'Endereço de email do destinatário',
  assunto VARCHAR(255) NOT NULL,
  mensagem TEXT NOT NULL,
  tipo_notificacao VARCHAR(50) NOT NULL DEFAULT 'falta' COMMENT 'Tipo: falta, justificativa, etc.',
  data_referencia DATE NOT NULL COMMENT 'Data da presença que gerou a notificação',
  status ENUM('PENDING', 'PROCESSING', 'RETRY', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
  tentativas INT NOT NULL DEFAULT 0,
  max_tentativas INT NOT NULL DEFAULT 5,
  ultimo_erro TEXT DEFAULT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processado_em DATETIME DEFAULT NULL,
  proxima_tentativa_em DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  -- Índice para o worker buscar jobs pendentes eficientemente
  KEY idx_email_jobs_status_proxima (status, proxima_tentativa_em),
  -- Índice para consultas por usuário
  KEY idx_email_jobs_usuario (usuario_id),
  -- Idempotência: mesmo aluno + tipo + data = apenas 1 job
  UNIQUE KEY uq_email_jobs_idempotencia (aluno_id, tipo_notificacao, data_referencia),
  -- Foreign keys
  CONSTRAINT fk_email_jobs_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
  CONSTRAINT fk_email_jobs_aluno FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
