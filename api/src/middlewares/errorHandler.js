// src/middlewares/errorHandler.js

const logger = require('../utils/logger');

/**
 * Middleware centralizado de tratamento de erros.
 * Captura qualquer erro lançado nas rotas e retorna resposta padronizada.
 */
function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  const mensagem = err.message || 'Erro interno do servidor.';

  if (status >= 500) {
    logger.error({ err, req: { method: req.method, url: req.originalUrl } }, '❌ Erro interno não tratado');
  } else {
    logger.warn({ err, req: { method: req.method, url: req.originalUrl } }, `⚠️ Erro de cliente (${status})`);
  }

  res.status(status).json({
    sucesso: false,
    erro: status === 500 ? 'Erro interno do servidor.' : mensagem,
  });
}

/**
 * Middleware para rotas não encontradas (404).
 */
function notFound(req, res) {
  res.status(404).json({
    sucesso: false,
    erro: `Rota ${req.method} ${req.originalUrl} não encontrada.`,
  });
}

module.exports = { errorHandler, notFound };
