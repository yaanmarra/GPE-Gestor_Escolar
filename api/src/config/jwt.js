// src/config/jwt.js
// Garante que .env está carregado (necessário quando scripts rodam fora do server.js)
if (!process.env.JWT_SECRET) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
}
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('Variável JWT_SECRET não definida no .env — o servidor não pode iniciar sem ela.');

const JWT_EXPIRES_IN     = process.env.JWT_EXPIRES_IN    || '15m';

const REFRESH_SECRET = process.env.REFRESH_SECRET;
if (!REFRESH_SECRET) throw new Error('Variável REFRESH_SECRET não definida no .env — o servidor não pode iniciar sem ela.');

const REFRESH_EXPIRES_IN = process.env.REFRESH_EXPIRES_IN || '7d';

/**
 * Gera um Access Token de curta duração.
 * @param {{ id: number, nome: string, tipo: string }} payload
 */
function gerarAccessToken(payload) {
  return jwt.sign(
    { id: payload.id, nome: payload.nome, tipo: payload.tipo },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Gera um Refresh Token de longa duração.
 * @param {{ id: number }} payload
 */
function gerarRefreshToken(payload) {
  return jwt.sign(
    { id: payload.id },
    REFRESH_SECRET,
    { expiresIn: REFRESH_EXPIRES_IN }
  );
}

/**
 * Verifica e decodifica um Access Token.
 * @param {string} token
 * @returns {{ id: number, nome: string, tipo: string }}
 */
function verificarAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Verifica e decodifica um Refresh Token.
 * @param {string} token
 * @returns {{ id: number }}
 */
function verificarRefreshToken(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

module.exports = {
  JWT_SECRET,
  REFRESH_SECRET,
  gerarAccessToken,
  gerarRefreshToken,
  verificarAccessToken,
  verificarRefreshToken,
};
