// src/config/portfolioSchema.js
// Garante de forma idempotente que todas as tabelas e colunas da Etapa 1 (Entrega 5 — Portfólio)
// existam no banco MySQL 8+, mesmo que o arquivo migration_entrega5_portfolio.sql não tenha sido
// executado manualmente.

let schemaPortfolioPromise = null;

async function executarPasso(db, nome, sql) {
  try {
    await db.query(sql);
  } catch (err) {
    console.error(`[PortfolioSchema] Erro no passo "${nome}": ${err.message} (${err.code})`);
    throw err;
  }
}

async function garantirSchemaPortfolio(pool) {
  const db = await pool.getConnection();
  let reutilizavel = false;
  try {
    const [[sessao]] = await db.query('SELECT @@SESSION.foreign_key_checks AS fk');
    await db.query('SET SESSION FOREIGN_KEY_CHECKS = 0');
    try {
      await aplicarSchemaPortfolio(db);
    } finally {
      await db.query('SET SESSION FOREIGN_KEY_CHECKS = ?', [sessao.fk]);
      reutilizavel = true;
    }
  } finally {
    if (reutilizavel) db.release();
    else db.destroy();
  }
}

async function aplicarSchemaPortfolio(db) {
  try {
    // 1. Disciplinas
    await executarPasso(db, 'disciplinas', `
      CREATE TABLE IF NOT EXISTS disciplinas (
        id INT NOT NULL AUTO_INCREMENT,
        nome VARCHAR(100) NOT NULL,
        carga_horaria_anual INT NOT NULL DEFAULT 80,
        criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_disciplina_nome (nome)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 2. Grade Horária Semanal
    await executarPasso(db, 'grade_horaria', `
      CREATE TABLE IF NOT EXISTS grade_horaria (
        id INT NOT NULL AUTO_INCREMENT,
        turma_id INT NOT NULL,
        professor_id INT NOT NULL,
        disciplina_id INT NULL,
        disciplina VARCHAR(100) NOT NULL,
        dia_semana ENUM('segunda','terca','quarta','quinta','sexta','sabado') NOT NULL,
        horario_inicio TIME NOT NULL,
        horario_fim TIME NOT NULL,
        ano_letivo YEAR NOT NULL DEFAULT 2026,
        criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_grade_turma_dia (turma_id, dia_semana, horario_inicio),
        KEY idx_grade_prof_dia (professor_id, dia_semana, horario_inicio),
        CONSTRAINT fk_grade_turma FOREIGN KEY (turma_id) REFERENCES turmas (id) ON DELETE CASCADE,
        CONSTRAINT fk_grade_prof FOREIGN KEY (professor_id) REFERENCES professores (id) ON DELETE CASCADE,
        CONSTRAINT fk_grade_disc FOREIGN KEY (disciplina_id) REFERENCES disciplinas (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 3. Evolução de Presenças (grade_horaria_id, abonada, slot_aula e índice UNIQUE por aula)
    const [colGrade] = await db.query("SHOW COLUMNS FROM presencas LIKE 'grade_horaria_id'");
    if (colGrade.length === 0) {
      await executarPasso(db, 'presencas_add_columns', `
        ALTER TABLE presencas
          ADD COLUMN grade_horaria_id INT NULL AFTER turma_id,
          ADD COLUMN abonada TINYINT(1) NOT NULL DEFAULT 0,
          ADD COLUMN slot_aula INT GENERATED ALWAYS AS (COALESCE(grade_horaria_id, 0)) STORED
      `);
      // Adiciona índice e chave estrangeira
      try {
        await db.query('ALTER TABLE presencas ADD KEY idx_pres_grade (grade_horaria_id)');
        await db.query('ALTER TABLE presencas ADD CONSTRAINT fk_pres_grade FOREIGN KEY (grade_horaria_id) REFERENCES grade_horaria (id) ON DELETE SET NULL');
      } catch (errFk) {
        console.warn('[PortfolioSchema] Aviso ao criar FK fk_pres_grade (índice mantido):', errFk.message);
      }
      // Atualiza idx_presenca_unica para incluir slot_aula
      try {
        const [idx] = await db.query("SHOW INDEX FROM presencas WHERE Key_name = 'idx_presenca_unica'");
        if (idx.length > 0) {
          await db.query('DROP INDEX idx_presenca_unica ON presencas');
        }
      } catch (_) {}
      try {
        await db.query('CREATE UNIQUE INDEX idx_presenca_unica ON presencas (aluno_id, data, professor_id, slot_aula)');
      } catch (errIdx) {
        console.warn('[PortfolioSchema] Aviso ao atualizar idx_presenca_unica:', errIdx.message);
      }
    }

    // 4. Calendário Letivo
    await executarPasso(db, 'calendario_letivo', `
      CREATE TABLE IF NOT EXISTS calendario_letivo (
        data DATE NOT NULL,
        ano_letivo YEAR NOT NULL,
        tipo ENUM('letivo','feriado','recesso','planejamento','sabado_letivo') NOT NULL DEFAULT 'letivo',
        descricao VARCHAR(150) NULL,
        PRIMARY KEY (data),
        KEY idx_cal_ano_tipo (ano_letivo, tipo)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 5. Vínculo N:N Aluno <-> Responsável
    await executarPasso(db, 'aluno_responsavel', `
      CREATE TABLE IF NOT EXISTS aluno_responsavel (
        aluno_id INT NOT NULL,
        pai_id INT NOT NULL,
        parentesco VARCHAR(40) NOT NULL DEFAULT 'responsavel',
        principal TINYINT(1) NOT NULL DEFAULT 0,
        recebe_notificacoes TINYINT(1) NOT NULL DEFAULT 1,
        criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (aluno_id, pai_id),
        KEY idx_ar_pai (pai_id),
        CONSTRAINT fk_ar_aluno FOREIGN KEY (aluno_id) REFERENCES alunos (id) ON DELETE CASCADE,
        CONSTRAINT fk_ar_pai FOREIGN KEY (pai_id) REFERENCES pais (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    try {
      await db.query(`
        INSERT IGNORE INTO aluno_responsavel (aluno_id, pai_id, parentesco, principal, recebe_notificacoes)
        SELECT id, pai_id, 'responsavel', 1, 1 FROM alunos WHERE pai_id IS NOT NULL
      `);
    } catch (_) {}

    // 6. Atividades e Avaliações
    await executarPasso(db, 'atividades', `
      CREATE TABLE IF NOT EXISTS atividades (
        id INT NOT NULL AUTO_INCREMENT,
        turma_id INT NOT NULL,
        professor_id INT NOT NULL,
        disciplina VARCHAR(100) NULL,
        titulo VARCHAR(150) NOT NULL,
        descricao TEXT NULL,
        tipo ENUM('prova','trabalho','licao','evento') NOT NULL DEFAULT 'prova',
        data_entrega DATE NOT NULL,
        valor_maximo DECIMAL(5,2) NOT NULL DEFAULT 10.00,
        criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_ativ_turma_data (turma_id, data_entrega),
        CONSTRAINT fk_ativ_turma FOREIGN KEY (turma_id) REFERENCES turmas (id) ON DELETE CASCADE,
        CONSTRAINT fk_ativ_prof FOREIGN KEY (professor_id) REFERENCES professores (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 7. Notas
    await executarPasso(db, 'notas', `
      CREATE TABLE IF NOT EXISTS notas (
        atividade_id INT NOT NULL,
        aluno_id INT NOT NULL,
        nota DECIMAL(5,2) NOT NULL,
        observacao VARCHAR(255) NULL,
        lancado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (atividade_id, aluno_id),
        KEY idx_notas_aluno (aluno_id),
        CONSTRAINT fk_notas_ativ FOREIGN KEY (atividade_id) REFERENCES atividades (id) ON DELETE CASCADE,
        CONSTRAINT fk_notas_aluno FOREIGN KEY (aluno_id) REFERENCES alunos (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 8. Ocorrências Pedagógicas e Comportamentais
    await executarPasso(db, 'ocorrencias', `
      CREATE TABLE IF NOT EXISTS ocorrencias (
        id INT NOT NULL AUTO_INCREMENT,
        aluno_id INT NOT NULL,
        professor_id INT NULL,
        autor_usuario_id INT NOT NULL,
        data DATE NOT NULL,
        tipo ENUM('elogio','atencao','indisciplina','sem_material','atraso','outros') NOT NULL,
        gravidade ENUM('positiva','leve','media','grave') NOT NULL DEFAULT 'leve',
        descricao TEXT NOT NULL,
        notificar_pais TINYINT(1) NOT NULL DEFAULT 0,
        notificado_em DATETIME NULL,
        criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_ocorr_aluno_data (aluno_id, data),
        CONSTRAINT fk_ocorr_aluno FOREIGN KEY (aluno_id) REFERENCES alunos (id) ON DELETE CASCADE,
        CONSTRAINT fk_ocorr_prof FOREIGN KEY (professor_id) REFERENCES professores (id) ON DELETE SET NULL,
        CONSTRAINT fk_ocorr_autor FOREIGN KEY (autor_usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 9. Comunicados e Confirmação de Leitura
    await executarPasso(db, 'comunicados', `
      CREATE TABLE IF NOT EXISTS comunicados (
        id INT NOT NULL AUTO_INCREMENT,
        autor_usuario_id INT NOT NULL,
        turma_id INT NULL,
        publico ENUM('todos','pais','alunos','professores') NOT NULL DEFAULT 'todos',
        titulo VARCHAR(150) NOT NULL,
        conteudo TEXT NOT NULL,
        enviar_whatsapp TINYINT(1) NOT NULL DEFAULT 0,
        data_publicacao DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_com_turma_data (turma_id, data_publicacao),
        CONSTRAINT fk_com_autor FOREIGN KEY (autor_usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE,
        CONSTRAINT fk_com_turma FOREIGN KEY (turma_id) REFERENCES turmas (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await executarPasso(db, 'comunicado_leituras', `
      CREATE TABLE IF NOT EXISTS comunicado_leituras (
        comunicado_id INT NOT NULL,
        usuario_id INT NOT NULL,
        lido_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (comunicado_id, usuario_id),
        KEY idx_cl_usuario (usuario_id),
        CONSTRAINT fk_cl_comunicado FOREIGN KEY (comunicado_id) REFERENCES comunicados (id) ON DELETE CASCADE,
        CONSTRAINT fk_cl_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 10. Casos de Acompanhamento / Busca Ativa
    await executarPasso(db, 'acompanhamento_casos', `
      CREATE TABLE IF NOT EXISTS acompanhamento_casos (
        id INT NOT NULL AUTO_INCREMENT,
        aluno_id INT NOT NULL,
        status ENUM('aberto','em_contato','visita_agendada','encaminhado_conselho','resolvido') NOT NULL DEFAULT 'aberto',
        nivel_risco ENUM('MODERADO','ALTO','CRITICO') NOT NULL DEFAULT 'ALTO',
        motivo_abertura VARCHAR(255) NOT NULL,
        resumo_acao TEXT NULL,
        responsavel_usuario_id INT NULL,
        protocolo_conselho VARCHAR(60) NULL,
        aberto_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        resolvido_em DATETIME NULL,
        PRIMARY KEY (id),
        KEY idx_casos_aluno_status (aluno_id, status),
        CONSTRAINT fk_casos_aluno FOREIGN KEY (aluno_id) REFERENCES alunos (id) ON DELETE CASCADE,
        CONSTRAINT fk_casos_resp FOREIGN KEY (responsavel_usuario_id) REFERENCES usuarios (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await executarPasso(db, 'acompanhamento_interacoes', `
      CREATE TABLE IF NOT EXISTS acompanhamento_interacoes (
        id INT NOT NULL AUTO_INCREMENT,
        caso_id INT NOT NULL,
        autor_usuario_id INT NULL,
        canal ENUM('whatsapp','telefone','presencial','email','conselho_tutelar','sistema') NOT NULL DEFAULT 'whatsapp',
        resultado ENUM('sucesso','sem_resposta','recado','encaminhado','outro') NOT NULL DEFAULT 'sucesso',
        descricao TEXT NOT NULL,
        criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_inter_caso (caso_id, criado_em),
        CONSTRAINT fk_inter_caso FOREIGN KEY (caso_id) REFERENCES acompanhamento_casos (id) ON DELETE CASCADE,
        CONSTRAINT fk_inter_autor FOREIGN KEY (autor_usuario_id) REFERENCES usuarios (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 11. Evolução de Justificativas
    const [colJustAluno] = await db.query("SHOW COLUMNS FROM justificativas LIKE 'aluno_id'");
    if (colJustAluno.length === 0) {
      await executarPasso(db, 'justificativas_alter', `
        ALTER TABLE justificativas
          MODIFY COLUMN presenca_id INT NULL,
          ADD COLUMN aluno_id INT NULL AFTER id,
          ADD COLUMN tipo ENUM('atestado_medico','declaracao_comparecimento','luto','forca_maior','outro') NOT NULL DEFAULT 'atestado_medico' AFTER presenca_id,
          ADD COLUMN data_inicio DATE NULL AFTER tipo,
          ADD COLUMN data_fim DATE NULL AFTER data_inicio,
          ADD COLUMN abona_falta TINYINT(1) NOT NULL DEFAULT 0,
          ADD COLUMN motivo_recusa TEXT NULL,
          ADD COLUMN homologado_por INT NULL,
          ADD COLUMN homologado_em DATETIME NULL,
          ADD KEY idx_just_aluno_status (aluno_id, status),
          ADD CONSTRAINT fk_just_aluno FOREIGN KEY (aluno_id) REFERENCES alunos (id) ON DELETE CASCADE,
          ADD CONSTRAINT fk_just_homologador FOREIGN KEY (homologado_por) REFERENCES usuarios (id) ON DELETE SET NULL
      `);
      // Backfill de aluno_id e datas para justificativas legadas ligadas a presenca_id
      try {
        await db.query(`
          UPDATE justificativas j
            JOIN presencas p ON p.id = j.presenca_id
             SET j.aluno_id = p.aluno_id,
                 j.data_inicio = COALESCE(j.data_inicio, p.data),
                 j.data_fim = COALESCE(j.data_fim, p.data)
           WHERE j.aluno_id IS NULL
        `);
      } catch (_) {}
    }

    // 12. Log de Auditoria
    await executarPasso(db, 'auditoria', `
      CREATE TABLE IF NOT EXISTS auditoria (
        id BIGINT NOT NULL AUTO_INCREMENT,
        usuario_id INT NULL,
        entidade VARCHAR(50) NOT NULL,
        entidade_id INT NULL,
        acao VARCHAR(50) NOT NULL,
        antes_json JSON NULL,
        depois_json JSON NULL,
        ip VARCHAR(45) NULL,
        criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_audit_entidade (entidade, entidade_id),
        KEY idx_audit_criado (criado_em),
        CONSTRAINT fk_audit_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  } catch (e) {
    console.error('[PortfolioSchema] Falha crítica ao aplicar schema do portfólio:', e.message);
    throw e;
  }
}

function prepararSchemaPortfolio() {
  if (!schemaPortfolioPromise) {
    const { dbPromise } = require('./database');
    schemaPortfolioPromise = garantirSchemaPortfolio(dbPromise);
  }
  return schemaPortfolioPromise;
}

module.exports = { garantirSchemaPortfolio, prepararSchemaPortfolio };

