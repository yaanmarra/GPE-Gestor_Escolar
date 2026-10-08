// src/utils/resposta.js

/**
 * Envia uma resposta de sucesso padronizada.
 * @param {import('express').Response} res
 * @param {any} dados - Dados a retornar.
 * @param {number} status - Status HTTP (default: 200).
 */
function sucesso(res, dados, status = 200) {
  return res.status(status).json({
    sucesso: true,
    dados,
  });
}

/**
 * Envia uma resposta de erro padronizada.
 * @param {import('express').Response} res
 * @param {string} mensagem - Mensagem de erro.
 * @param {number} status - Status HTTP (default: 400).
 */
function erro(res, mensagem, status = 400) {
  return res.status(status).json({
    sucesso: false,
    erro: mensagem,
  });
}

module.exports = { sucesso, erro };
