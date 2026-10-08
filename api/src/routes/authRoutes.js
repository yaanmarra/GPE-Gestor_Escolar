// src/routes/authRoutes.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const router  = express.Router();

const { db }                = require('../config/database');
const { sucesso, erro }     = require('../utils/resposta');
const { validarEmail }      = require('../utils/validadores');
const {
  gerarAccessToken,
  gerarRefreshToken,
  verificarRefreshToken,
} = require('../config/jwt');

// ─────────────────────────────────────────
// POST /api/login
// ─────────────────────────────────────────
router.post('/login', (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha)
    return erro(res, 'Informe o e-mail e a senha.');

  if (!validarEmail(email))
    return erro(res, 'Formato de e-mail inválido.');

  db.query(
    'SELECT id, nome, email, senha, tipo FROM usuarios WHERE email = ?',
    [email],
    async (err, results) => {
      if (err) return erro(res, 'Erro no servidor.', 500);
      if (results.length === 0)
        return erro(res, 'E-mail ou senha incorretos.', 401);

      const usuario = results[0];

      // Comparar senha com bcrypt
      try {
        const senhaValida = await bcrypt.compare(senha, usuario.senha);
        if (!senhaValida)
          return erro(res, 'E-mail ou senha incorretos.', 401);
      } catch {
        return erro(res, 'Erro ao verificar credenciais.', 500);
      }

      // Gerar tokens
      const accessToken  = gerarAccessToken({ id: usuario.id, nome: usuario.nome, tipo: usuario.tipo });
      const refreshToken = gerarRefreshToken({ id: usuario.id });

      // Salvar refresh token no banco
      db.query(
        'UPDATE usuarios SET refresh_token = ? WHERE id = ?',
        [refreshToken, usuario.id]
      );

      sucesso(res, {
        accessToken,
        refreshToken,
        usuario: {
          id:   usuario.id,
          nome: usuario.nome,
          tipo: usuario.tipo,
        }
      });
    }
  );
});

// ─────────────────────────────────────────
// POST /api/refresh-token
// ─────────────────────────────────────────
router.post('/refresh-token', (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken)
    return erro(res, 'Refresh token não fornecido.', 401);

  try {
    const decoded = verificarRefreshToken(refreshToken);

    // Verificar se o refresh token existe no banco
    db.query(
      'SELECT id, nome, tipo, refresh_token FROM usuarios WHERE id = ?',
      [decoded.id],
      (err, results) => {
        if (err) return erro(res, 'Erro no servidor.', 500);
        if (results.length === 0)
          return erro(res, 'Usuário não encontrado.', 401);

        const usuario = results[0];

        if (usuario.refresh_token !== refreshToken)
          return erro(res, 'Refresh token inválido.', 401);

        // Gerar novo access token
        const novoAccessToken = gerarAccessToken({
          id:   usuario.id,
          nome: usuario.nome,
          tipo: usuario.tipo,
        });

        sucesso(res, { accessToken: novoAccessToken });
      }
    );
  } catch {
    return erro(res, 'Refresh token expirado ou inválido. Faça login novamente.', 401);
  }
});

// ─────────────────────────────────────────
// POST /api/logout
// ─────────────────────────────────────────
router.post('/logout', (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken)
    return sucesso(res, { mensagem: 'Sessão encerrada.' });

  // Limpar refresh token do banco
  try {
    const decoded = verificarRefreshToken(refreshToken);
    db.query(
      'UPDATE usuarios SET refresh_token = NULL WHERE id = ?',
      [decoded.id]
    );
  } catch {
    // Token já expirado, não faz nada
  }

  sucesso(res, { mensagem: 'Sessão encerrada com sucesso.' });
});

module.exports = router;
