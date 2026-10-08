// src/routes/turmaRoutes.js
const express = require('express');
const router  = express.Router();

const { db, dbPromise } = require('../config/database');
const { sucesso, erro } = require('../utils/resposta');
const { autenticar, autorizar } = require('../middlewares/auth');

// ─────────────────────────────────────────
// GET /api/turmas — Listar todas as turmas
// ─────────────────────────────────────────
router.get('/', autenticar, autorizar('gestor', 'professor'), async (req, res) => {
  try {
    let sql, params;

    if (req.usuario.tipo === 'professor') {
      // Professor só vê suas próprias turmas
      sql = `SELECT t.id, t.nome, t.ano, t.turno, t.ativa,
                    COUNT(DISTINCT a.id) AS total_alunos
             FROM turmas t
             JOIN professor_turma pt ON pt.turma_id = t.id
             JOIN professores pr ON pr.id = pt.professor_id
             LEFT JOIN alunos a ON a.turma_id = t.id
             WHERE pr.usuario_id = ?
             GROUP BY t.id
             ORDER BY t.ano DESC, t.nome`;
      params = [req.usuario.id];
    } else {
      // Gestor: acesso irrestrito
      sql = `SELECT t.id, t.nome, t.ano, t.turno, t.ativa,
                    COUNT(DISTINCT a.id) AS total_alunos
             FROM turmas t
             LEFT JOIN alunos a ON a.turma_id = t.id
             GROUP BY t.id
             ORDER BY t.ano DESC, t.nome`;
      params = [];
    }

    const [results] = await dbPromise.query(sql, params);
    sucesso(res, results);
  } catch (e) {
    erro(res, 'Erro ao listar turmas.', 500);
  }
});

// ─────────────────────────────────────────
// GET /api/turmas/:id — Buscar turma por ID
// ─────────────────────────────────────────
router.get('/:id', autenticar, autorizar('gestor', 'professor'), (req, res) => {
  db.query(
    'SELECT * FROM turmas WHERE id = ?',
    [req.params.id],
    (err, results) => {
      if (err) return erro(res, 'Erro ao buscar turma.', 500);
      if (results.length === 0) return erro(res, 'Turma não encontrada.', 404);
      sucesso(res, results[0]);
    }
  );
});

// ─────────────────────────────────────────
// POST /api/turmas — Criar turma
// ─────────────────────────────────────────
router.post('/', autenticar, autorizar('gestor'), (req, res) => {
  const { nome, ano, turno } = req.body;

  if (!nome || !ano)
    return erro(res, 'Informe o nome e o ano da turma.');

  const turnoValido = turno || 'matutino';

  db.query(
    'INSERT INTO turmas (nome, ano, turno) VALUES (?, ?, ?)',
    [nome, ano, turnoValido],
    (err, result) => {
      if (err) return erro(res, 'Erro ao criar turma.', 500);
      sucesso(res, { mensagem: 'Turma criada com sucesso!', id: result.insertId }, 201);
    }
  );
});

// ─────────────────────────────────────────
// PUT /api/turmas/:id — Editar turma
// ─────────────────────────────────────────
router.put('/:id', autenticar, autorizar('gestor'), (req, res) => {
  const { nome, ano, turno, ativa } = req.body;

  if (!nome || !ano)
    return erro(res, 'Informe o nome e o ano da turma.');

  db.query(
    'UPDATE turmas SET nome = ?, ano = ?, turno = ?, ativa = ? WHERE id = ?',
    [nome, ano, turno || 'matutino', ativa ?? 1, req.params.id],
    (err, result) => {
      if (err) return erro(res, 'Erro ao atualizar turma.', 500);
      if (result.affectedRows === 0) return erro(res, 'Turma não encontrada.', 404);
      sucesso(res, { mensagem: 'Turma atualizada com sucesso!' });
    }
  );
});

// ─────────────────────────────────────────
// DELETE /api/turmas/:id — Excluir turma
// ─────────────────────────────────────────
router.delete('/:id', autenticar, autorizar('gestor'), (req, res) => {
  db.query(
    'DELETE FROM turmas WHERE id = ?',
    [req.params.id],
    (err, result) => {
      if (err) return erro(res, 'Erro ao excluir turma.', 500);
      if (result.affectedRows === 0) return erro(res, 'Turma não encontrada.', 404);
      sucesso(res, { mensagem: 'Turma excluída com sucesso!' });
    }
  );
});

// ─────────────────────────────────────────
// GET /api/turmas/:id/alunos — Listar alunos de uma turma
// ─────────────────────────────────────────
router.get('/:id/alunos', autenticar, autorizar('gestor', 'professor'), async (req, res) => {
  // Professor só pode listar alunos de turmas às quais está vinculado
  if (req.usuario.tipo === 'professor') {
    try {
      const [vinculo] = await dbPromise.query(
        `SELECT 1 FROM professor_turma pt
         JOIN professores pr ON pr.id = pt.professor_id
         WHERE pr.usuario_id = ? AND pt.turma_id = ?
         LIMIT 1`,
        [req.usuario.id, req.params.id]
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
      `SELECT a.id, u.nome, u.email, t.nome AS turma, a.turma_id
       FROM alunos a
       JOIN usuarios u ON u.id = a.usuario_id
       LEFT JOIN turmas t ON t.id = a.turma_id
       WHERE a.turma_id = ?
       ORDER BY u.nome`,
      [req.params.id]
    );
    sucesso(res, results);
  } catch (e) {
    erro(res, 'Erro ao listar alunos da turma.', 500);
  }
});

// ─────────────────────────────────────────
// POST /api/turmas/:id/professores — Vincular professor
// ─────────────────────────────────────────
router.post('/:id/professores', autenticar, autorizar('gestor'), (req, res) => {
  const { professor_id } = req.body;

  if (!professor_id)
    return erro(res, 'Informe o professor_id.');

  db.query(
    'INSERT IGNORE INTO professor_turma (professor_id, turma_id) VALUES (?, ?)',
    [professor_id, req.params.id],
    (err) => {
      if (err) return erro(res, 'Erro ao vincular professor.', 500);
      sucesso(res, { mensagem: 'Professor vinculado à turma com sucesso!' });
    }
  );
});

// ─────────────────────────────────────────
// DELETE /api/turmas/:id/professores/:professor_id — Desvincular professor
// ─────────────────────────────────────────
router.delete('/:id/professores/:professor_id', autenticar, autorizar('gestor'), (req, res) => {
  db.query(
    'DELETE FROM professor_turma WHERE professor_id = ? AND turma_id = ?',
    [req.params.professor_id, req.params.id],
    (err, result) => {
      if (err) return erro(res, 'Erro ao desvincular professor.', 500);
      if (result.affectedRows === 0) return erro(res, 'Vínculo não encontrado.', 404);
      sucesso(res, { mensagem: 'Professor desvinculado com sucesso!' });
    }
  );
});

module.exports = router;
