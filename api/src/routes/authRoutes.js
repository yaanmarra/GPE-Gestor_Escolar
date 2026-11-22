// src/routes/authRoutes.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const router  = express.Router();

const { dbPromise }         = require('../config/database');
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
router.post('/login', async (req, res) => {
  const { email, senha } = req.body || {};

  if (!email || !senha)
    return erro(res, 'Informe o e-mail e a senha.');

  if (!validarEmail(email))
    return erro(res, 'Formato de e-mail inválido.');

  try {
    const [results] = await dbPromise.query(
      'SELECT id, nome, email, senha, tipo FROM usuarios WHERE email = ?',
      [email]
    );
    if (results.length === 0)
      return erro(res, 'E-mail ou senha incorretos.', 401);

    const usuario = results[0];

    // Comparar senha com bcrypt
    const senhaValida = await bcrypt.compare(senha, usuario.senha);
    if (!senhaValida)
      return erro(res, 'E-mail ou senha incorretos.', 401);

    // Gerar tokens
    const accessToken  = gerarAccessToken({ id: usuario.id, nome: usuario.nome, tipo: usuario.tipo });
    const refreshToken = gerarRefreshToken({ id: usuario.id });

    // Salvar refresh token no banco de forma síncrona (await) antes de responder
    await dbPromise.query(
      'UPDATE usuarios SET refresh_token = ? WHERE id = ?',
      [refreshToken, usuario.id]
    );

    return sucesso(res, {
      accessToken,
      refreshToken,
      usuario: {
        id:   usuario.id,
        nome: usuario.nome,
        tipo: usuario.tipo,
      }
    });
  } catch {
    return erro(res, 'Erro no servidor.', 500);
  }
});

// ─────────────────────────────────────────
// POST /api/refresh-token
// ─────────────────────────────────────────
router.post('/refresh-token', async (req, res) => {
  const { refreshToken } = req.body || {};

  if (!refreshToken)
    return erro(res, 'Refresh token não fornecido.', 401);

  let decoded;
  try {
    decoded = verificarRefreshToken(refreshToken);
  } catch {
    return erro(res, 'Refresh token expirado ou inválido. Faça login novamente.', 401);
  }

  try {
    // Verificar se o refresh token existe e corresponde ao armazenado no banco
    const [results] = await dbPromise.query(
      'SELECT id, nome, tipo, refresh_token FROM usuarios WHERE id = ?',
      [decoded.id]
    );
    if (results.length === 0)
      return erro(res, 'Usuário não encontrado.', 401);

    const usuario = results[0];

    if (!usuario.refresh_token || usuario.refresh_token !== refreshToken)
      return erro(res, 'Refresh token inválido.', 401);

    // Gerar novo access token
    const novoAccessToken = gerarAccessToken({
      id:   usuario.id,
      nome: usuario.nome,
      tipo: usuario.tipo,
    });

    return sucesso(res, { accessToken: novoAccessToken });
  } catch {
    return erro(res, 'Erro no servidor.', 500);
  }
});

// ─────────────────────────────────────────
// POST /api/logout
// ─────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body || {};

  if (!refreshToken)
    return sucesso(res, { mensagem: 'Sessão encerrada.' });

  // Revogar refresh token no banco de forma síncrona antes de responder (mitigação VULN-02)
  let decoded = null;
  try {
    decoded = verificarRefreshToken(refreshToken);
  } catch {
    // Token já expirado ou inválido: não há sessão ativa para revogar
  }

  if (decoded?.id) {
    try {
      await dbPromise.query(
        'UPDATE usuarios SET refresh_token = NULL WHERE id = ? AND refresh_token = ?',
        [decoded.id, refreshToken]
      );
    } catch {
      return erro(res, 'Erro ao encerrar sessão.', 500);
    }
  }

  return sucesso(res, { mensagem: 'Sessão encerrada com sucesso.' });
});

module.exports = router;
