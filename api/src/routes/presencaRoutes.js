// src/routes/presencaRoutes.js
const express = require('express');
const router  = express.Router();

const { dbPromise } = require('../config/database');
const { sucesso, erro } = require('../utils/resposta');
const { autenticar, autorizar } = require('../middlewares/auth');
const notificacaoService = require('../services/notificacaoService');
const frequenciaService = require('../services/frequenciaService');

const STATUS_PRESENCA_VALIDOS = new Set(['presente', 'falta', 'justificado']);
const REGEX_DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function dataValida(valor) {
  if (typeof valor !== 'string' || !REGEX_DATA_ISO.test(valor)) return false;
  const d = new Date(`${valor}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === valor;
}

function idPositivoValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0;
}

// ─────────────────────────────────────────
// POST /api/registrar-presenca — Registro individual
// ─────────────────────────────────────────
router.post('/registrar-presenca', autenticar, autorizar('professor', 'gestor'), async (req, res) => {
  const { aluno_id, professor_id, turma_id, grade_horaria_id, data, status } = req.body || {};

  if (!aluno_id || !data || !status) {
    return erro(res, 'Preencha todos os campos: aluno, data e status.', 400);
  }
  if (!idPositivoValido(aluno_id)) {
    return erro(res, 'ID de aluno inválido.', 400);
  }
  if (!dataValida(data)) {
    return erro(res, 'Formato de data inválido. Use YYYY-MM-DD.', 400);
  }
  if (!STATUS_PRESENCA_VALIDOS.has(status)) {
    return erro(res, 'Status de presença inválido. Valores permitidos: presente, falta, justificado.', 400);
  }
  if (professor_id !== undefined && professor_id !== null && professor_id !== '' && !idPositivoValido(professor_id)) {
    return erro(res, 'ID de professor inválido.', 400);
  }
  if (turma_id !== undefined && turma_id !== null && turma_id !== '' && !idPositivoValido(turma_id)) {
    return erro(res, 'ID de turma inválido.', 400);
  }
  if (grade_horaria_id !== undefined && grade_horaria_id !== null && grade_horaria_id !== '' && !idPositivoValido(grade_horaria_id)) {
    return erro(res, 'ID de grade horária inválido.', 400);
  }

  const alunoIdNum = Number(aluno_id);
  const conn = await dbPromise.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Validar aluno e bloquear registro para evitar condição de corrida (TC-39-07) e mutação de matrícula
    const [alunoRows] = await conn.query(
      'SELECT id, turma_id FROM alunos WHERE id = ? FOR UPDATE',
      [alunoIdNum]
    );
    if (alunoRows.length === 0) {
      await conn.rollback();
      return erro(res, 'Aluno não encontrado.', 404);
    }
    const aluno = alunoRows[0];
    const turmaIdAluno = aluno.turma_id ? Number(aluno.turma_id) : null;

    if (turma_id !== undefined && turma_id !== null && turma_id !== '' && Number(turma_id) !== turmaIdAluno) {
      await conn.rollback();
      return erro(res, 'Acesso negado. O aluno não pertence à turma informada.', 403);
    }

    // 2. Identificar e autorizar o agente responsável (VULN-01)
    let idProfEfetivo = null;

    if (req.usuario.tipo === 'professor') {
      const [profRows] = await conn.query(
        'SELECT id FROM professores WHERE usuario_id = ? LIMIT 1',
        [req.usuario.id]
      );
      if (profRows.length === 0) {
        await conn.rollback();
        return erro(res, 'Acesso negado. Cadastro de professor não encontrado para o usuário autenticado.', 403);
      }
      const profAutenticadoId = Number(profRows[0].id);

      // Bloqueia tentativa de falsificar professor_id no corpo da requisição (SEC-REG-10)
      if (professor_id !== undefined && professor_id !== null && professor_id !== '' && Number(professor_id) !== profAutenticadoId) {
        await conn.rollback();
        return erro(res, 'Acesso negado. Não é permitido registrar presença em nome de outro professor.', 403);
      }

      if (!turmaIdAluno) {
        await conn.rollback();
        return erro(res, 'Acesso negado. O aluno não está matriculado em uma turma vinculada a você.', 403);
      }

      // Valida vínculo estrito entre o professor autenticado e a turma do aluno (SEC-REG-01 / SEC-REG-02 / SEC-REG-06)
      const [vinculo] = await conn.query(
        'SELECT 1 FROM professor_turma WHERE professor_id = ? AND turma_id = ? LIMIT 1',
        [profAutenticadoId, turmaIdAluno]
      );
      if (vinculo.length === 0) {
        await conn.rollback();
        return erro(res, 'Acesso negado. Este aluno não pertence às suas turmas.', 403);
      }

      if (grade_horaria_id) {
        const [gradeRows] = await conn.query(
          'SELECT id, turma_id, professor_id FROM grade_horaria WHERE id = ? LIMIT 1',
          [Number(grade_horaria_id)]
        );
        if (
          gradeRows.length === 0 ||
          Number(gradeRows[0].turma_id) !== turmaIdAluno ||
          Number(gradeRows[0].professor_id) !== profAutenticadoId
        ) {
          await conn.rollback();
          return erro(res, 'Acesso negado. Grade horária inválida para este professor ou turma.', 403);
        }
      }

      idProfEfetivo = profAutenticadoId;
    } else {
      // Perfil gestor: preserva permissões administrativas legítimas (SEC-REG-06),
      // sem fallback arbitrário para o primeiro professor da tabela.
      if (professor_id !== undefined && professor_id !== null && professor_id !== '') {
        const [pRow] = await conn.query('SELECT id FROM professores WHERE id = ? LIMIT 1', [Number(professor_id)]);
        if (pRow.length === 0) {
          await conn.rollback();
          return erro(res, 'Professor informado não encontrado.', 400);
        }
        idProfEfetivo = Number(pRow[0].id);
      } else if (turmaIdAluno) {
        const [ptRow] = await conn.query(
          'SELECT professor_id FROM professor_turma WHERE turma_id = ? ORDER BY professor_id ASC LIMIT 1',
          [turmaIdAluno]
        );
        if (ptRow.length > 0) idProfEfetivo = Number(ptRow[0].professor_id);
      }
    }

    if (req.usuario.tipo === 'gestor' && grade_horaria_id) {
      const [[grade]] = await conn.query(
        'SELECT professor_id FROM grade_horaria WHERE id = ? AND turma_id = ?',
        [grade_horaria_id, turmaIdAluno]);
      if (!grade || (professor_id && Number(professor_id) !== grade.professor_id)) {
        await conn.rollback();
        return erro(res, 'Horário incompatível com a turma ou professor.', 400);
      }
      idProfEfetivo = grade.professor_id;
    }

    if (!idProfEfetivo) {
      await conn.rollback();
      return erro(res, 'Nenhum professor vinculado à turma. Informe professor_id ou vincule um professor à turma.', 400);
    }
    // 3. Verificar estado anterior da presença na mesma data/slot (Idempotência e Retificação TC-39)
    const restringirProfessor = req.usuario.tipo === 'professor' || Boolean(professor_id);
    const [existentes] = await conn.query(
      `SELECT id, status FROM presencas WHERE aluno_id = ? AND data = ?
       AND grade_horaria_id <=> ? ${restringirProfessor ? 'AND professor_id = ?' : ''} FOR UPDATE`,
      [alunoIdNum, data, Number(grade_horaria_id) || null, ...(restringirProfessor ? [idProfEfetivo] : [])]
    );
    if (existentes.length > 1) {
      await conn.rollback();
      return erro(res, 'Informe o professor para identificar a chamada.', 409);
    }
    const registroAnterior = existentes[0] || null;
    const statusAnterior = registroAnterior ? registroAnterior.status : null;

    if (registroAnterior) {
      if (statusAnterior !== status) {
        // Caso C (falta -> presente/justificado) ou Caso D (presente/justificado -> falta)
        // Atualiza o status preservando o professor_id (autoria original)
        await conn.query(
          'UPDATE presencas SET status = ?, turma_id = COALESCE(?, turma_id) WHERE id = ?',
          [status, turmaIdAluno, registroAnterior.id]
        );
      }
      // Caso B (repetição idêntica): mantém o registro sem duplicar
    } else {
      // Caso A (primeiro registro) com ON DUPLICATE KEY UPDATE para segurança sob concorrência
      if (grade_horaria_id) {
        await conn.query(
          `INSERT INTO presencas (aluno_id, professor_id, turma_id, grade_horaria_id, data, status)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             status = VALUES(status),
             turma_id = COALESCE(VALUES(turma_id), turma_id)`,
          [alunoIdNum, idProfEfetivo, turmaIdAluno, Number(grade_horaria_id), data, status]
        );
      } else {
        await conn.query(
          `INSERT INTO presencas (aluno_id, professor_id, turma_id, data, status)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             status = VALUES(status),
             turma_id = COALESCE(VALUES(turma_id), turma_id)`,
          [alunoIdNum, idProfEfetivo, turmaIdAluno, data, status]
        );
      }
    }

    // 4. Orquestrar notificações conforme a transição de estado (Preservação do Outbox)
    let notificou = false;
    if (status === 'falta') {
      if (statusAnterior !== 'falta') {
        const { notificados } = await notificacaoService.registrarFaltas(conn, { alunoIds: [alunoIdNum], data });
        notificou = notificados > 0;
      }
    } else {
      await notificacaoService.cancelarFaltasCorrigidas(conn, { alunoIds: [alunoIdNum], data });
    }

    await conn.commit();
    sucesso(res, {
      mensagem: notificou
        ? 'Presença registrada e notificação agendada.'
        : 'Presença registrada com sucesso.',
      alterado: statusAnterior !== status,
      status_anterior: statusAnterior,
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
  const { professor_id, turma_id, grade_horaria_id, data, presencas } = req.body || {};
  if (!data || !Array.isArray(presencas) || presencas.length === 0) {
    return erro(res, 'Campos obrigatórios: data, presencas[].', 400);
  }
  if (!dataValida(data)) {
    return erro(res, 'Formato de data inválido. Use YYYY-MM-DD.', 400);
  }
  if (turma_id !== undefined && turma_id !== null && turma_id !== '' && !idPositivoValido(turma_id)) {
    return erro(res, 'ID de turma inválido.', 400);
  }
  if (professor_id !== undefined && professor_id !== null && professor_id !== '' && !idPositivoValido(professor_id)) {
    return erro(res, 'ID de professor inválido.', 400);
  }
  if (grade_horaria_id !== undefined && grade_horaria_id !== null && grade_horaria_id !== '' && !idPositivoValido(grade_horaria_id)) {
    return erro(res, 'ID de grade horária inválido.', 400);
  }

  for (const item of presencas) {
    if (!item || !idPositivoValido(item.aluno_id) || !STATUS_PRESENCA_VALIDOS.has(item.status)) {
      return erro(res, 'Cada item de presencas deve conter aluno_id válido e status (presente, falta ou justificado).', 400);
    }
    if (item.grade_horaria_id !== undefined && item.grade_horaria_id !== null && item.grade_horaria_id !== '' && !idPositivoValido(item.grade_horaria_id)) {
      return erro(res, 'ID de grade horária inválido no item da chamada.', 400);
    }
  }

  // Deduplica itens repetidos do mesmo aluno no payload mantendo a última ocorrência
  const mapaItens = new Map();
  for (const item of presencas) {
    const chave = `${Number(item.aluno_id)}:${Number(item.grade_horaria_id || grade_horaria_id || 0)}`;
    mapaItens.set(chave, {
      aluno_id: Number(item.aluno_id),
      status: item.status,
      grade_horaria_id: item.grade_horaria_id ? Number(item.grade_horaria_id) : (grade_horaria_id ? Number(grade_horaria_id) : null),
    });
  }
  const itensNormalizados = [...mapaItens.values()];
  const alunoIdsUnicos = [...new Set(itensNormalizados.map(i => i.aluno_id))].sort((a, b) => a - b);

  // Transação atômica: validação de vínculo + presenças + notificações (Outbox)
  const conn = await dbPromise.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Verificar existência e turma de TODOS os alunos do lote com bloqueio de linha (SEC-REG-09)
    const [alunosRows] = await conn.query(
      'SELECT id, turma_id FROM alunos WHERE id IN (?) ORDER BY id ASC FOR UPDATE',
      [alunoIdsUnicos]
    );
    if (alunosRows.length !== alunoIdsUnicos.length) {
      await conn.rollback();
      return erro(res, 'Um ou mais alunos informados não foram encontrados.', 400);
    }

    if (alunosRows.some(a => !a.turma_id)) {
      await conn.rollback();
      return erro(res, 'Acesso negado. Há aluno sem turma vinculada no lote.', 403);
    }

    const turmasDosAlunos = [...new Set(alunosRows.map(a => Number(a.turma_id)))];
    if (turma_id !== undefined && turma_id !== null && turma_id !== '') {
      if (turmasDosAlunos.length > 1 || turmasDosAlunos[0] !== Number(turma_id)) {
        await conn.rollback();
        return erro(res, 'Acesso negado. Um ou mais alunos não pertencem à turma informada.', 403);
      }
    } else if (turmasDosAlunos.length > 1) {
      await conn.rollback();
      return erro(res, 'Acesso negado. Todos os alunos da chamada em lote devem pertencer à mesma turma.', 403);
    }

    const turmaIdEfetiva = (turma_id !== undefined && turma_id !== null && turma_id !== '')
      ? Number(turma_id)
      : turmasDosAlunos[0];

    // 2. Identificar e autorizar o agente responsável (VULN-01 / SEC-REG-03 a SEC-REG-10)
    let idProfEfetivo = null;

    if (req.usuario.tipo === 'professor') {
      const [profRows] = await conn.query(
        'SELECT id FROM professores WHERE usuario_id = ? LIMIT 1',
        [req.usuario.id]
      );
      if (profRows.length === 0) {
        await conn.rollback();
        return erro(res, 'Acesso negado. Cadastro de professor não encontrado para o usuário autenticado.', 403);
      }
      const profAutenticadoId = Number(profRows[0].id);

      // Bloqueia tentativa de falsificar professor_id no corpo da requisição (SEC-REG-10)
      if (professor_id !== undefined && professor_id !== null && professor_id !== '' && Number(professor_id) !== profAutenticadoId) {
        await conn.rollback();
        return erro(res, 'Acesso negado. Não é permitido registrar chamada em nome de outro professor.', 403);
      }

      // Valida obrigatoriamente o vínculo professor <-> turma, com ou sem grade_horaria_id (SEC-REG-04 e SEC-REG-05)
      const [vinculo] = await conn.query(
        'SELECT 1 FROM professor_turma WHERE professor_id = ? AND turma_id = ? LIMIT 1',
        [profAutenticadoId, turmaIdEfetiva]
      );
      if (vinculo.length === 0) {
        await conn.rollback();
        return erro(res, 'Acesso negado. Esta turma não está vinculada a você.', 403);
      }

      const gradesIds = [...new Set(itensNormalizados.map(i => i.grade_horaria_id).filter(Boolean))];
      if (gradesIds.length > 0) {
        const [gradesRows] = await conn.query(
          'SELECT id, turma_id, professor_id FROM grade_horaria WHERE id IN (?)',
          [gradesIds]
        );
        if (
          gradesRows.length !== gradesIds.length ||
          gradesRows.some(g => Number(g.turma_id) !== turmaIdEfetiva || Number(g.professor_id) !== profAutenticadoId)
        ) {
          await conn.rollback();
          return erro(res, 'Acesso negado. Grade horária inválida para este professor ou turma.', 403);
        }
      }

      idProfEfetivo = profAutenticadoId;
    } else {
      // Perfil gestor: preserva permissões administrativas legítimas (SEC-REG-06),
      // sem fallback arbitrário para o primeiro professor da tabela.
      if (professor_id !== undefined && professor_id !== null && professor_id !== '') {
        const [pRow] = await conn.query('SELECT id FROM professores WHERE id = ? LIMIT 1', [Number(professor_id)]);
        if (pRow.length === 0) {
          await conn.rollback();
          return erro(res, 'Professor informado não encontrado.', 400);
        }
        idProfEfetivo = Number(pRow[0].id);
      } else {
        const [ptRow] = await conn.query(
          'SELECT professor_id FROM professor_turma WHERE turma_id = ? ORDER BY professor_id ASC LIMIT 1',
          [turmaIdEfetiva]
        );
        if (ptRow.length > 0) idProfEfetivo = Number(ptRow[0].professor_id);
      }
    }

    const professoresPorGrade = new Map();
    if (req.usuario.tipo === 'gestor') {
      const ids = [...new Set(itensNormalizados.map(i => i.grade_horaria_id).filter(Boolean))];
      if (ids.length) {
        const [grades] = await conn.query(
          'SELECT id, professor_id FROM grade_horaria WHERE id IN (?) AND turma_id = ?', [ids, turmaIdEfetiva]);
        if (grades.length !== ids.length || (professor_id && grades.some(g => g.professor_id !== Number(professor_id)))) {
          await conn.rollback();
          return erro(res, 'Horário incompatível com a turma ou professor.', 400);
        }
        for (const grade of grades) professoresPorGrade.set(grade.id, grade.professor_id);
      }
    }

    if (!idProfEfetivo && itensNormalizados.some(i => !professoresPorGrade.has(i.grade_horaria_id))) {
      await conn.rollback();
      return erro(res, 'Nenhum professor vinculado à turma. Informe professor_id ou vincule um professor à turma.', 400);
    }
    // 3. Consultar presenças existentes para preservar autoria e controlar transições de notificação
    const restringirProfessor = req.usuario.tipo === 'professor' || Boolean(professor_id);
    const [existentes] = await conn.query(
      `SELECT id, aluno_id, status, grade_horaria_id FROM presencas
       WHERE aluno_id IN (?) AND data = ? ${restringirProfessor ? 'AND professor_id = ?' : ''} FOR UPDATE`,
      [alunoIdsUnicos, data, ...(restringirProfessor ? [idProfEfetivo] : [])]
    );
    const mapaExistentes = new Map();
    for (const reg of existentes) {
      const chave = `${reg.aluno_id}:${reg.grade_horaria_id || 0}`;
      if (!mapaItens.has(chave)) continue;
      if (mapaExistentes.has(chave)) {
        await conn.rollback();
        return erro(res, 'Informe o professor para identificar a chamada.', 409);
      }
      mapaExistentes.set(chave, reg);
    }

    const faltasParaNotificar = [];
    const corrigidosIds = [];

    for (const item of itensNormalizados) {
      const regAnt = mapaExistentes.get(`${item.aluno_id}:${item.grade_horaria_id || 0}`) || null;
      const statusAnt = regAnt ? regAnt.status : null;

      if (regAnt) {
        if (statusAnt !== item.status) {
          await conn.query(
            'UPDATE presencas SET status = ?, turma_id = COALESCE(?, turma_id) WHERE id = ?',
            [item.status, turmaIdEfetiva, regAnt.id]
          );
        }
      } else if (item.grade_horaria_id) {
        await conn.query(
          `INSERT INTO presencas (aluno_id, professor_id, turma_id, grade_horaria_id, data, status)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             status = VALUES(status),
             turma_id = COALESCE(VALUES(turma_id), turma_id)`,
          [item.aluno_id, professoresPorGrade.get(item.grade_horaria_id) ?? idProfEfetivo, turmaIdEfetiva, item.grade_horaria_id, data, item.status]
        );
      } else {
        await conn.query(
          `INSERT INTO presencas (aluno_id, professor_id, turma_id, data, status)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             status = VALUES(status),
             turma_id = COALESCE(VALUES(turma_id), turma_id)`,
          [item.aluno_id, idProfEfetivo, turmaIdEfetiva, data, item.status]
        );
      }

      if (item.status === 'falta') {
        if (statusAnt !== 'falta') {
          faltasParaNotificar.push(item.aluno_id);
        }
      } else {
        corrigidosIds.push(item.aluno_id);
      }
    }

    // 4. Processar faltas novas/alteradas e cancelamentos de faltas retificadas
    let notificados = 0;
    if (faltasParaNotificar.length > 0) {
      const r = await notificacaoService.registrarFaltas(conn, { alunoIds: faltasParaNotificar, data });
      notificados = r.notificados;
    }
    if (corrigidosIds.length > 0) {
      await notificacaoService.cancelarFaltasCorrigidas(conn, { alunoIds: corrigidosIds, data });
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
               a.id AS aluno_id, u.nome AS aluno,
               COUNT(CASE WHEN p.status = 'presente'    THEN 1 END) AS presencas,
               COUNT(CASE WHEN p.status = 'falta'       THEN 1 END) AS faltas,
               COUNT(CASE WHEN p.status = 'justificado' THEN 1 END) AS justificadas
             FROM presencas p
             JOIN alunos a   ON a.id = p.aluno_id
             JOIN usuarios u ON u.id = a.usuario_id
             JOIN professor_turma pt ON pt.turma_id = a.turma_id
             JOIN professores pr ON pr.id = pt.professor_id
             WHERE pr.usuario_id = ?
             GROUP BY a.id, u.nome
             ORDER BY u.nome`;
      params = [req.usuario.id];
    } else {
      // Gestor: acesso irrestrito
      sql = `SELECT
               a.id AS aluno_id, u.nome AS aluno,
               COUNT(CASE WHEN p.status = 'presente'    THEN 1 END) AS presencas,
               COUNT(CASE WHEN p.status = 'falta'       THEN 1 END) AS faltas,
               COUNT(CASE WHEN p.status = 'justificado' THEN 1 END) AS justificadas
             FROM presencas p
             JOIN alunos a   ON a.id = p.aluno_id
             JOIN usuarios u ON u.id = a.usuario_id
             GROUP BY a.id, u.nome
             ORDER BY u.nome`;
      params = [];
    }

    const [results] = await dbPromise.query(sql, params);
    const enriquecidos = results.map(r => {
      const m = frequenciaService.calcularMetricasFrequencia({
        presencas: r.presencas,
        faltas: r.faltas,
        justificadas: r.justificadas,
      });
      return {
        ...r,
        percentual_ldb: m.percentualLDB,
        regular_ldb: m.programas.ldb.regular,
        faltas_restantes_ldb: m.faltasRestantesLDB,
        aulas_para_recuperar: m.aulasParaRecuperarLDB,
      };
    });
    sucesso(res, enriquecidos);
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
    const diaria = req.query.chamada === 'diaria';
    const horario = req.query.grade_horaria_id;
    if (horario !== undefined && (!idPositivoValido(horario) || diaria)) {
      return erro(res, 'Informe uma chamada diária ou um horário válido.', 400);
    }
    const docente = (diaria || horario !== undefined) && req.usuario.tipo === 'professor';
    const [results] = await dbPromise.query(
      `SELECT p.aluno_id, p.status FROM presencas p JOIN alunos a ON a.id = p.aluno_id
       WHERE a.turma_id = ? AND p.data = ?
       ${diaria ? 'AND p.grade_horaria_id IS NULL' : ''}
       ${horario !== undefined ? 'AND p.grade_horaria_id = ?' : ''}
       ${docente ? 'AND p.professor_id IN (SELECT id FROM professores WHERE usuario_id = ?)' : ''}`,
      [turma_id, data, ...(horario !== undefined ? [Number(horario)] : []), ...(docente ? [req.usuario.id] : [])]
    );
    if (diaria && new Set(results.map(r => r.aluno_id)).size !== results.length) {
      return erro(res, 'Há mais de uma chamada diária para o mesmo aluno. Consulte o histórico por professor.', 409);
    }
    sucesso(res, results);
  } catch (e) {
    erro(res, 'Erro ao buscar presenças da turma.', 500);
  }
});

// ─────────────────────────────────────────
// GET /api/frequencia/radar — Radar de Permanência Escolar (Score ABC + LDB + Programas Sociais)
// ─────────────────────────────────────────
router.get('/frequencia/radar', autenticar, autorizar('gestor', 'professor'), async (req, res) => {
  try {
    const turmaId = req.query.turma_id ? Number(req.query.turma_id) : null;
    let itens = await frequenciaService.gerarRadarPermanencia(dbPromise, { turmaId });

    // Professor só visualiza alunos das turmas às quais está vinculado
    if (req.usuario.tipo === 'professor') {
      const [turmasProf] = await dbPromise.query(
        `SELECT pt.turma_id
           FROM professor_turma pt
           JOIN professores p ON p.id = pt.professor_id
          WHERE p.usuario_id = ?`,
        [req.usuario.id]
      );
      const permitidas = new Set(turmasProf.map(t => t.turma_id));
      itens = itens.filter(i => permitidas.has(i.aluno.turma_id));
    }

    sucesso(res, itens);
  } catch (e) {
    console.error('Erro ao gerar radar de permanência:', e.message);
    erro(res, 'Erro ao gerar radar de permanência.', 500);
  }
});

// ─────────────────────────────────────────
// GET /api/frequencia/diagnostico/:aluno_id — Diagnóstico unificado de um aluno
// ─────────────────────────────────────────
router.get('/frequencia/diagnostico/:aluno_id', autenticar, async (req, res) => {
  const alunoId = Number(req.params.aluno_id);
  if (!alunoId) return erro(res, 'ID de aluno inválido.', 400);

  try {
    const diag = await frequenciaService.obterDiagnosticoAluno(dbPromise, alunoId);
    if (!diag) return erro(res, 'Aluno não encontrado.', 404);

    // Proteção IDOR por perfil
    if (req.usuario.tipo === 'aluno' && diag.aluno.usuario_id !== req.usuario.id) {
      return erro(res, 'Acesso negado.', 403);
    }
    if (req.usuario.tipo === 'professor') {
      const [vincProf] = await dbPromise.query(
        `SELECT 1 FROM professor_turma pt
           JOIN professores p ON p.id = pt.professor_id
          WHERE p.usuario_id = ? AND pt.turma_id = ?
          LIMIT 1`,
        [req.usuario.id, diag.aluno.turma_id]
      );
      if (vincProf.length === 0) return erro(res, 'Acesso negado. Este aluno não pertence às suas turmas.', 403);
    }
    if (req.usuario.tipo === 'pai') {
      const [vinc] = await dbPromise.query(
        `SELECT 1 FROM pais p
           LEFT JOIN aluno_responsavel ar ON ar.pai_id = p.id AND ar.aluno_id = ?
          WHERE p.usuario_id = ? AND (p.id = ? OR ar.aluno_id IS NOT NULL)
          LIMIT 1`,
        [alunoId, req.usuario.id, diag.aluno.pai_id]
      );
      if (vinc.length === 0) return erro(res, 'Acesso negado.', 403);
    }

    sucesso(res, diag);
  } catch (e) {
    erro(res, 'Erro ao calcular diagnóstico de frequência.', 500);
  }
});

module.exports = router;
