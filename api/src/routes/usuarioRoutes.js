// src/routes/usuarioRoutes.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const router  = express.Router();

const { db, dbPromise } = require('../config/database');
const { sucesso, erro } = require('../utils/resposta');
const { autenticar, autorizar } = require('../middlewares/auth');
const { validarEmail, validarSenha, validarTipo, validarCamposObrigatorios } = require('../utils/validadores');

// ─────────────────────────────────────────
// POST /api/cadastro — Cadastrar novo usuário
// Apenas gestores podem cadastrar
// ─────────────────────────────────────────
router.post('/cadastro', autenticar, autorizar('gestor'), (req, res) => {
  const { nome, email, senha, tipo, telefone, disciplina, turma_id, pai_id } = req.body;

  // 1) Validação dos campos básicos
  const { valido, faltando } = validarCamposObrigatorios(['nome', 'email', 'senha', 'tipo'], req.body);
  if (!valido)
    return erro(res, `Campos obrigatórios faltando: ${faltando.join(', ')}.`);

  if (!validarEmail(email))
    return erro(res, 'Formato de e-mail inválido.');

  if (!validarSenha(senha))
    return erro(res, 'A senha deve ter no mínimo 6 caracteres.');

  if (!validarTipo(tipo))
    return erro(res, 'Tipo de usuário inválido. Use: aluno, pai, professor ou gestor.');

  if (tipo === 'aluno' && !pai_id)
    return erro(res, 'Para cadastrar um aluno, informe o ID do pai/responsável.');

  if (tipo === 'aluno' && !turma_id)
    return erro(res, 'Para cadastrar um aluno, selecione a turma.');

  if (tipo === 'professor' && !disciplina)
    return erro(res, 'Para cadastrar um professor, informe a disciplina.');

  // 2) Verificar se e-mail já existe
  db.query('SELECT id FROM usuarios WHERE email = ?', [email], async (err, rows) => {
    if (err) return erro(res, 'Erro ao verificar e-mail.', 500);

    if (rows.length > 0)
      return erro(res, `O e-mail "${email}" já está cadastrado no sistema.`);

    // 3) Hash da senha com bcrypt
    let senhaHash;
    try {
      senhaHash = await bcrypt.hash(senha, 12);
    } catch {
      return erro(res, 'Erro ao processar a senha.', 500);
    }

    // 4) Se for aluno, verificar se o pai_id existe
    if (tipo === 'aluno') {
      db.query('SELECT id FROM pais WHERE id = ?', [pai_id], (err2, paiRows) => {
        if (err2) return erro(res, 'Erro ao verificar pai/responsável.', 500);

        if (paiRows.length === 0)
          return erro(res, `Pai/responsável com ID ${pai_id} não encontrado.`);

        executarCadastro(res, { nome, email, senha: senhaHash, tipo, telefone, disciplina, turma_id, pai_id });
      });
    } else {
      executarCadastro(res, { nome, email, senha: senhaHash, tipo, telefone, disciplina, turma_id, pai_id });
    }
  });
});

function executarCadastro(res, dados) {
  const { nome, email, senha, tipo, telefone, disciplina, turma_id, pai_id } = dados;

  db.getConnection((errConn, conn) => {
    if (errConn) return erro(res, 'Erro ao obter conexão com o banco.', 500);

    conn.beginTransaction((errTx) => {
      if (errTx) {
        conn.release();
        return erro(res, 'Erro ao iniciar transação.', 500);
      }

      conn.query(
        'INSERT INTO usuarios (nome, email, senha, tipo) VALUES (?, ?, ?, ?)',
        [nome, email, senha, tipo],
        (err, result) => {
          if (err) {
            return conn.rollback(() => {
              conn.release();
              erro(res, 'Erro ao criar usuário.', 500);
            });
          }

          const usuario_id = result.insertId;
          let sql, valores, nomeTabela;

          switch (tipo) {
            case 'pai':
              sql = 'INSERT INTO pais (usuario_id, telefone) VALUES (?, ?)';
              valores = [usuario_id, telefone || null];
              nomeTabela = 'Pai';
              break;
            case 'professor':
              sql = 'INSERT INTO professores (usuario_id, disciplina) VALUES (?, ?)';
              valores = [usuario_id, disciplina];
              nomeTabela = 'Professor';
              break;
            case 'aluno':
              sql = 'INSERT INTO alunos (usuario_id, pai_id, turma_id) VALUES (?, ?, ?)';
              valores = [usuario_id, pai_id, turma_id || null];
              nomeTabela = 'Aluno';
              break;
            default:
              return conn.commit((errC) => {
                if (errC) {
                  return conn.rollback(() => {
                    conn.release();
                    erro(res, 'Erro ao finalizar cadastro.', 500);
                  });
                }
                conn.release();
                sucesso(res, { mensagem: 'Gestor cadastrado com sucesso!' }, 201);
              });
          }

          conn.query(sql, valores, (err2) => {
            if (err2) {
              return conn.rollback(() => {
                conn.release();
                erro(res, `Erro ao cadastrar ${nomeTabela}.`, 500);
              });
            }

            conn.commit((errC) => {
              if (errC) {
                return conn.rollback(() => {
                  conn.release();
                  erro(res, 'Erro ao confirmar cadastro.', 500);
                });
              }
              conn.release();
              sucesso(res, { mensagem: `${nomeTabela} cadastrado(a) com sucesso!` }, 201);
            });
          });
        }
      );
    });
  });
}

// ─────────────────────────────────────────
// GET /api/usuarios — Listar todos (apenas gestor)
// ─────────────────────────────────────────
router.get('/usuarios', autenticar, autorizar('gestor'), async (req, res, next) => {
  try {
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 100);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * limit;

    const [countRows] = await dbPromise.query('SELECT COUNT(*) as total FROM usuarios');
    const [results] = await dbPromise.query(
      'SELECT id, nome, email, tipo FROM usuarios ORDER BY nome LIMIT ? OFFSET ?',
      [limit, offset]
    );

    sucesso(res, { dados: results, meta: { total: countRows[0].total, page, limit } });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────
// GET /api/pais — Listar pais
// ─────────────────────────────────────────
router.get('/pais', autenticar, autorizar('gestor'), async (req, res, next) => {
  try {
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 100);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * limit;

    const [countRows] = await dbPromise.query('SELECT COUNT(*) as total FROM pais p JOIN usuarios u ON p.usuario_id = u.id');
    const [results] = await dbPromise.query(
      `SELECT p.id, u.nome, u.email, p.telefone
       FROM pais p JOIN usuarios u ON p.usuario_id = u.id ORDER BY u.nome LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    sucesso(res, { dados: results, meta: { total: countRows[0].total, page, limit } });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────
// GET /api/professores — Listar professores
// ─────────────────────────────────────────
router.get('/professores', autenticar, autorizar('gestor', 'professor'), async (req, res, next) => {
  try {
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 100);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * limit;

    const [countRows] = await dbPromise.query('SELECT COUNT(*) as total FROM professores pr JOIN usuarios u ON pr.usuario_id = u.id');
    const [results] = await dbPromise.query(
      `SELECT pr.id, u.nome, u.email, pr.disciplina
       FROM professores pr JOIN usuarios u ON pr.usuario_id = u.id ORDER BY u.nome LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    sucesso(res, { dados: results, meta: { total: countRows[0].total, page, limit } });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────
// GET /api/alunos — Listar alunos
// ─────────────────────────────────────────
router.get('/alunos', autenticar, autorizar('gestor', 'professor'), async (req, res, next) => {
  try {
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 100);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * limit;

    const [countRows] = await dbPromise.query('SELECT COUNT(*) as total FROM alunos a JOIN usuarios u ON a.usuario_id = u.id');
    const [results] = await dbPromise.query(
      `SELECT a.id, u.nome, u.email, t.nome AS turma, a.turma_id, a.pai_id
       FROM alunos a JOIN usuarios u ON a.usuario_id = u.id
       LEFT JOIN turmas t ON t.id = a.turma_id ORDER BY u.nome LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    sucesso(res, { dados: results, meta: { total: countRows[0].total, page, limit } });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────
// PATCH /api/alunos/:id/turma — Vincular aluno à turma
// ─────────────────────────────────────────
router.patch('/alunos/:id/turma', autenticar, autorizar('gestor'), (req, res) => {
  const { turma_id } = req.body;

  db.query(
    'UPDATE alunos SET turma_id = ? WHERE id = ?',
    [turma_id || null, req.params.id],
    (err, result) => {
      if (err) return erro(res, 'Erro ao vincular aluno à turma.', 500);
      if (result.affectedRows === 0) return erro(res, 'Aluno não encontrado.', 404);
      sucesso(res, { mensagem: 'Aluno vinculado à turma com sucesso!' });
    }
  );
});

module.exports = router;
