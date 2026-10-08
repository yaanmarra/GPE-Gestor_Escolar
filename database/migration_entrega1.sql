-- Otimização e Segurança - Entrega 1

-- Índice para buscas por data de presença (mais usada em relatórios)
CREATE INDEX idx_presencas_data ON presencas(data);

-- Índice composto para busca de presença por aluno e data
CREATE INDEX idx_presencas_aluno_data ON presencas(aluno_id, data);

-- Índice para busca de alunos por turma (usado na chamada em lote)
CREATE INDEX idx_alunos_turma ON alunos(turma_id);

-- Índice para busca de notificações por usuário
CREATE INDEX idx_notificacoes_usuario ON notificacoes(usuario_id, data_envio);

-- Índice UNIQUE para evitar presença duplicada (aluno+data+professor)
CREATE UNIQUE INDEX idx_presenca_unica ON presencas(aluno_id, data, professor_id);

-- Adicionar campo para armazenar o refresh token do JWT
ALTER TABLE usuarios ADD COLUMN refresh_token VARCHAR(500) DEFAULT NULL;

-- Adicionar campo para rastrear quando o usuário foi criado
ALTER TABLE usuarios ADD COLUMN criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
