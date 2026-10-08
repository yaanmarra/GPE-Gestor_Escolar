// src/routes/presencaRoutes.js
const express = require('express');
const router  = express.Router();

const { db, dbPromise } = require('../config/database');
const { sucesso, erro } = require('../utils/resposta');
const { autenticar, autorizar } = require('../middlewares/auth');
// emailService removido das rotas — envio será feito pelo worker (Fase 3)
const emailConfig = require('../config/emailConfig');

// ─────────────────────────────────────────
// POST /api/registrar-presenca — Registro individual
// ─────────────────────────────────────────
router.post('/registrar-presenca', autenticar, autorizar('professor', 'gestor'), async (req, res) => {
  let { aluno_id, professor_id, data, status } = req.body;

  if (!aluno_id || !data || !status)
    return erro(res, 'Preencha todos os campos: aluno, data e status.');

  // Resolver professor_id válido
  try {
    let idProfValido = null;
    if (req.usuario.tipo === 'professor') {
      const [profRow] = await dbPromise.query('SELECT id FROM professores WHERE usuario_id = ?', [req.usuario.id]);
      if (profRow.length > 0) idProfValido = profRow[0].id;
    }
    if (!idProfValido && professor_id) {
      const [pRow] = await dbPromise.query('SELECT id FROM professores WHERE id = ?', [professor_id]);
      if (pRow.length > 0) idProfValido = pRow[0].id;
    }
    if (!idProfValido) {
      const [firstProf] = await dbPromise.query('SELECT id FROM professores ORDER BY id ASC LIMIT 1');
      if (firstProf.length > 0) idProfValido = firstProf[0].id;
    }
    if (!idProfValido) return erro(res, 'Nenhum professor cadastrado no sistema.', 400);
    professor_id = idProfValido;
  } catch (e) {
    return erro(res, 'Erro ao validar professor responsável.', 500);
  }

  // Transação: presença + notificação (Outbox)
  const conn = await dbPromise.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Inserir presença
    await conn.query(
      'INSERT INTO presencas (aluno_id, professor_id, data, status) VALUES (?, ?, ?, ?)',
      [aluno_id, professor_id, data, status]
    );

    // 2. Se for falta → criar notificação in-app + email job PENDING
    let notificou = false;
    if (status === 'falta') {
      const [rows] = await conn.query(
        `SELECT u.id AS usuario_pai_id, u.nome AS nome_responsavel, u.email AS email_responsavel,
                ua.nome AS nome_aluno, t.nome AS turma
         FROM alunos a
         JOIN pais p      ON a.pai_id = p.id
         JOIN usuarios u  ON p.usuario_id = u.id
         JOIN usuarios ua ON a.usuario_id = ua.id
         LEFT JOIN turmas t ON t.id = a.turma_id
         WHERE a.id = ? LIMIT 1`,
        [aluno_id]
      );

      if (rows.length > 0) {
        const { usuario_pai_id, nome_responsavel, email_responsavel, nome_aluno, turma } = rows[0];
        const mensagem = `Olá, ${nome_responsavel}. Foi registrada uma FALTA para o aluno ${nome_aluno} (turma ${turma || 'N/A'}) na data ${data}.`;
        const assunto = `Aviso de falta - ${nome_aluno}`;

        // Notificação in-app
        await conn.query(
          'INSERT INTO notificacoes (usuario_id, mensagem) VALUES (?, ?)',
          [usuario_pai_id, mensagem]
        );

        // Email job PENDING — idempotente via UNIQUE KEY (aluno_id, tipo, data)
        await conn.query(
          `INSERT INTO email_jobs (usuario_id, aluno_id, destinatario, assunto, mensagem, tipo_notificacao, data_referencia, status, max_tentativas)
           VALUES (?, ?, ?, ?, ?, 'falta', ?, 'PENDING', ?)
           ON DUPLICATE KEY UPDATE id = id`,
          [usuario_pai_id, aluno_id, email_responsavel, assunto, mensagem, data, emailConfig.maxTentativas]
        );
        notificou = true;
      }
    }

    await conn.commit();
    sucesso(res, {
      mensagem: notificou
        ? 'Presença registrada e notificação agendada.'
        : 'Presença registrada com sucesso.'
    });
  } catch (e) {
    await conn.rollback();
    console.error('Erro ao registrar presença (transação):', e.message);
    erro(res, 'Erro ao registrar presença.', 500);
  } finally {
    conn.release();
  }
});

// ─────────────────────────────────────────
// POST /api/registrar-presenca-turma — Registro em lote
// ─────────────────────────────────────────
router.post('/registrar-presenca-turma', autenticar, autorizar('professor', 'gestor'), async (req, res) => {
  let { professor_id, turma_id, data, presencas } = req.body;
  if (!data || !Array.isArray(presencas) || presencas.length === 0)
    return erro(res, 'Campos obrigatórios: data, presencas[].');

  // Resolver professor_id válido
  try {
    let idProfValido = null;

    if (req.usuario.tipo === 'professor') {
      const [profRow] = await dbPromise.query('SELECT id FROM professores WHERE usuario_id = ?', [req.usuario.id]);
      if (profRow.length > 0) idProfValido = profRow[0].id;
    }
    if (!idProfValido && professor_id) {
      const [pRow] = await dbPromise.query('SELECT id FROM professores WHERE id = ?', [professor_id]);
      if (pRow.length > 0) idProfValido = pRow[0].id;
    }
    if (!idProfValido && turma_id) {
      const [ptRow] = await dbPromise.query('SELECT professor_id FROM professor_turma WHERE turma_id = ? LIMIT 1', [turma_id]);
      if (ptRow.length > 0) idProfValido = ptRow[0].professor_id;
    }
    if (!idProfValido && presencas[0]?.aluno_id) {
      const [aRow] = await dbPromise.query(
        'SELECT pt.professor_id FROM alunos a JOIN professor_turma pt ON pt.turma_id = a.turma_id WHERE a.id = ? LIMIT 1',
        [presencas[0].aluno_id]
      );
      if (aRow.length > 0) idProfValido = aRow[0].professor_id;
    }
    if (!idProfValido) {
      const [firstProf] = await dbPromise.query('SELECT id FROM professores ORDER BY id ASC LIMIT 1');
      if (firstProf.length > 0) idProfValido = firstProf[0].id;
    }
    if (!idProfValido) return erro(res, 'Nenhum professor cadastrado para vincular a chamada.', 400);
    professor_id = idProfValido;
  } catch (e) {
    console.error('Erro ao resolver professor:', e);
    return erro(res, 'Erro ao validar professor responsável.', 500);
  }

  // Transação: presenças + notificações (Outbox)
  const conn = await dbPromise.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Inserir presenças em lote
    const valores = presencas.map(p => [p.aluno_id, professor_id, data, p.status]);
    await conn.query(
      `INSERT INTO presencas (aluno_id, professor_id, data, status)
       VALUES ?
       ON DUPLICATE KEY UPDATE status = VALUES(status), professor_id = VALUES(professor_id)`,
      [valores]
    );

    // 2. Processar faltas → notificações in-app + email jobs PENDING
    const faltas = presencas.filter(p => p.status === 'falta');
    let notificados = 0;

    if (faltas.length > 0) {
      const ids = faltas.map(p => p.aluno_id);
      const [rows] = await conn.query(
        `SELECT a.id AS aluno_id, u.id AS usuario_pai_id, u.nome AS nome_responsavel,
                u.email AS email_responsavel, ua.nome AS nome_aluno, t.nome AS turma
         FROM alunos a
         JOIN pais p      ON a.pai_id = p.id
         JOIN usuarios u  ON p.usuario_id = u.id
         JOIN usuarios ua ON a.usuario_id = ua.id
         LEFT JOIN turmas t ON t.id = a.turma_id
         WHERE a.id IN (?)`,
        [ids]
      );

      for (const r of rows) {
        const msg = `Olá, ${r.nome_responsavel}. Foi registrada uma FALTA para o aluno ${r.nome_aluno} (turma ${r.turma || 'N/A'}) na data ${data}.`;
        const assunto = `Aviso de falta - ${r.nome_aluno}`;

        // Notificação in-app
        await conn.query(
          'INSERT INTO notificacoes (usuario_id, mensagem) VALUES (?, ?)',
          [r.usuario_pai_id, msg]
        );

        // Email job PENDING — idempotente via UNIQUE KEY (aluno_id, tipo, data)
        await conn.query(
          `INSERT INTO email_jobs (usuario_id, aluno_id, destinatario, assunto, mensagem, tipo_notificacao, data_referencia, status, max_tentativas)
           VALUES (?, ?, ?, ?, ?, 'falta', ?, 'PENDING', ?)
           ON DUPLICATE KEY UPDATE id = id`,
          [r.usuario_pai_id, r.aluno_id, r.email_responsavel, assunto, msg, data, emailConfig.maxTentativas]
        );
        notificados++;
      }
    }

    await conn.commit();
    sucesso(res, {
      mensagem: `${presencas.length} presenças registradas.${notificados > 0 ? ` ${notificados} notificação(ões) agendada(s).` : ''}`
    });
  } catch (e) {
    await conn.rollback();
    console.error('Erro ao registrar presenças em lote (transação):', e.message);
    erro(res, 'Erro ao registrar presenças em lote.', 500);
  } finally {
    conn.release();
  }
});

// ─────────────────────────────────────────
// GET /api/presencas — Listar presenças (geral)
// ─────────────────────────────────────────
router.get('/presencas', autenticar, autorizar('gestor', 'professor'), async (req, res) => {
  try {
    let sql, params;

    if (req.usuario.tipo === 'professor') {
      // Professor só vê alunos de suas turmas
      sql = `SELECT p.id, u.nome AS aluno, p.data, p.status
             FROM presencas p
             JOIN alunos a   ON a.id = p.aluno_id
             JOIN usuarios u ON u.id = a.usuario_id
             JOIN professor_turma pt ON pt.turma_id = a.turma_id
             JOIN professores pr ON pr.id = pt.professor_id
             WHERE pr.usuario_id = ?
             ORDER BY p.data DESC`;
      params = [req.usuario.id];
    } else {
      // Gestor: acesso irrestrito
      sql = `SELECT p.id, u.nome AS aluno, p.data, p.status
             FROM presencas p
             JOIN alunos a   ON a.id = p.aluno_id
             JOIN usuarios u ON u.id = a.usuario_id
             ORDER BY p.data DESC`;
      params = [];
    }

    const [results] = await dbPromise.query(sql, params);
    sucesso(res, results);
  } catch (e) {
    erro(res, 'Erro ao buscar presenças.', 500);
  }
});

// ─────────────────────────────────────────
// GET /api/presencas/:usuario_id — Presenças de um aluno
// ─────────────────────────────────────────
router.get('/presencas/:usuario_id', autenticar, autorizar('aluno', 'gestor', 'professor'), async (req, res) => {
  const usuarioIdParam = Number(req.params.usuario_id);

  // IDOR: Aluno só pode consultar o próprio histórico
  if (req.usuario.tipo === 'aluno' && req.usuario.id !== usuarioIdParam) {
    return erro(res, 'Acesso negado. Você só pode consultar seu próprio histórico.', 403);
  }

  // Professor só pode consultar alunos de suas turmas
  if (req.usuario.tipo === 'professor') {
    try {
      const [vinculo] = await dbPromise.query(
        `SELECT 1 FROM alunos a
         JOIN professor_turma pt ON pt.turma_id = a.turma_id
         JOIN professores p ON p.id = pt.professor_id
         WHERE a.usuario_id = ? AND p.usuario_id = ?
         LIMIT 1`,
        [usuarioIdParam, req.usuario.id]
      );
      if (vinculo.length === 0) {
        return erro(res, 'Acesso negado. Este aluno não pertence às suas turmas.', 403);
      }
    } catch (e) {
      return erro(res, 'Erro ao verificar autorização.', 500);
    }
  }

  // Gestor: acesso irrestrito (mantido)

  try {
    const [results] = await dbPromise.query(
      `SELECT p.data, p.status, u_prof.nome AS professor
       FROM presencas p
       JOIN alunos a        ON p.aluno_id = a.id
       JOIN professores pr  ON p.professor_id = pr.id
       JOIN usuarios u_prof ON pr.usuario_id = u_prof.id
       WHERE a.usuario_id = ?
       ORDER BY p.data DESC`,
      [usuarioIdParam]
    );
    sucesso(res, results);
  } catch (e) {
    erro(res, 'Erro ao buscar presenças.', 500);
  }
});

// ─────────────────────────────────────────
// GET /api/presencas-filho/:usuario_id — Presenças dos filhos (pai)
// ─────────────────────────────────────────
router.get('/presencas-filho/:usuario_id', autenticar, autorizar('pai', 'gestor'), async (req, res) => {
  const usuarioIdParam = Number(req.params.usuario_id);

  // IDOR: Pai só pode consultar os próprios filhos
  if (req.usuario.tipo === 'pai' && req.usuario.id !== usuarioIdParam) {
    return erro(res, 'Acesso negado. Você só pode consultar os próprios filhos.', 403);
  }

  // Gestor: acesso irrestrito (mantido)

  try {
    const [results] = await dbPromise.query(
      `SELECT us_al.nome AS aluno, p.data, p.status
       FROM presencas p
       JOIN alunos a    ON a.id = p.aluno_id
       JOIN usuarios us_al ON us_al.id = a.usuario_id
       JOIN pais pa     ON pa.id = a.pai_id
       JOIN usuarios u  ON u.id = pa.usuario_id
       WHERE u.id = ?
       ORDER BY p.data DESC`,
      [usuarioIdParam]
    );
    sucesso(res, results);
  } catch (e) {
    erro(res, 'Erro ao buscar presenças do filho.', 500);
  }
});

// ─────────────────────────────────────────
// GET /api/relatorio-frequencia — Relatório geral
// ─────────────────────────────────────────
router.get('/relatorio-frequencia', autenticar, autorizar('gestor', 'professor'), async (req, res) => {
  try {
    let sql, params;

    if (req.usuario.tipo === 'professor') {
      // Professor só vê relatório dos alunos de suas turmas
      sql = `SELECT
               u.nome AS aluno,
               COUNT(CASE WHEN p.status = 'presente'    THEN 1 END) AS presencas,
               COUNT(CASE WHEN p.status = 'falta'       THEN 1 END) AS faltas,
               COUNT(CASE WHEN p.status = 'justificado' THEN 1 END) AS justificadas
             FROM presencas p
             JOIN alunos a   ON a.id = p.aluno_id
             JOIN usuarios u ON u.id = a.usuario_id
             JOIN professor_turma pt ON pt.turma_id = a.turma_id
             JOIN professores pr ON pr.id = pt.professor_id
             WHERE pr.usuario_id = ?
             GROUP BY u.nome
             ORDER BY u.nome`;
      params = [req.usuario.id];
    } else {
      // Gestor: acesso irrestrito
      sql = `SELECT
               u.nome AS aluno,
               COUNT(CASE WHEN p.status = 'presente'    THEN 1 END) AS presencas,
               COUNT(CASE WHEN p.status = 'falta'       THEN 1 END) AS faltas,
               COUNT(CASE WHEN p.status = 'justificado' THEN 1 END) AS justificadas
             FROM presencas p
             JOIN alunos a   ON a.id = p.aluno_id
             JOIN usuarios u ON u.id = a.usuario_id
             GROUP BY u.nome
             ORDER BY u.nome`;
      params = [];
    }

    const [results] = await dbPromise.query(sql, params);
    sucesso(res, results);
  } catch (e) {
    erro(res, 'Erro ao gerar relatório.', 500);
  }
});

// ─────────────────────────────────────────
// GET /api/presencas-turma — Presenças de uma turma num dia
// ─────────────────────────────────────────
router.get('/presencas-turma', autenticar, autorizar('gestor', 'professor'), async (req, res) => {
  const { turma_id, data } = req.query;
  if (!turma_id || !data) return erro(res, 'Informe turma_id e data.');

  // Professor só pode consultar turmas às quais está vinculado
  if (req.usuario.tipo === 'professor') {
    try {
      const [vinculo] = await dbPromise.query(
        `SELECT 1 FROM professor_turma pt
         JOIN professores pr ON pr.id = pt.professor_id
         WHERE pr.usuario_id = ? AND pt.turma_id = ?
         LIMIT 1`,
        [req.usuario.id, turma_id]
      );
      if (vinculo.length === 0) {
        return erro(res, 'Acesso negado. Esta turma não está vinculada a você.', 403);
      }
    } catch (e) {
      return erro(res, 'Erro ao verificar autorização.', 500);
    }
  }

  try {
    const [results] = await dbPromise.query(
      `SELECT p.aluno_id, p.status
       FROM presencas p
       JOIN alunos a ON a.id = p.aluno_id
       WHERE a.turma_id = ? AND p.data = ?`,
      [turma_id, data]
    );
    sucesso(res, results);
  } catch (e) {
    erro(res, 'Erro ao buscar presenças da turma.', 500);
  }
});

module.exports = router;
