// src/providers/whatsapp/comum.js
// Utilitários compartilhados pelos providers de WhatsApp.
const crypto = require('crypto');

const TEMPORARIO = 'TEMPORARIO';
const PERMANENTE = 'PERMANENTE';

/**
 * POST/GET JSON com timeout. Em erro HTTP lança Error com { status, corpo };
 * em erro de rede lança Error com { rede: true, code }.
 */
async function requisicaoJson(url, { method = 'POST', headers = {}, body, timeoutMs = 15_000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw Object.assign(new Error(timeout ? 'Timeout na chamada ao provider' : `Falha de rede: ${e.message}`), {
      code: timeout ? 'ETIMEDOUT' : 'ENETWORK',
      rede: true,
    });
  }

  const texto = await res.text();
  let corpo = null;
  try { corpo = texto ? JSON.parse(texto) : null; } catch (_) { corpo = { bruto: texto.slice(0, 300) }; }

  if (!res.ok) {
    throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, corpo });
  }
  return corpo;
}

/**
 * Classificação genérica por HTTP:
 *  - erro de rede/timeout, 429, 5xx → TEMPORARIO
 *  - 401/403/404 → TEMPORARIO (configuração do sistema: token/instância; não é culpa do job.
 *    Mesmo raciocínio do EAUTH no e-mail; o limite de tentativas continua valendo)
 *  - demais 4xx → PERMANENTE (requisição inválida não melhora com retry)
 */
function classificarHttp(err) {
  if (!err) return TEMPORARIO;
  if (err.permanente === true) return PERMANENTE;
  if (err.rede) return TEMPORARIO;
  const s = Number(err.status);
  if (!s) return TEMPORARIO;
  if (s === 429 || s >= 500) return TEMPORARIO;
  if (s === 401 || s === 403 || s === 404) return TEMPORARIO;
  if (s >= 400 && s < 500) return PERMANENTE;
  return TEMPORARIO;
}

/** Comparação em tempo constante (evita timing attack em tokens/assinaturas). */
function iguaisSeguro(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Valida token simples enviado como ?token=... (Evolution / fake). */
function validarTokenQuery(req, verifyToken) {
  if (!verifyToken) return false;
  return iguaisSeguro(req.query?.token, verifyToken);
}

/** Palavras que o responsável pode responder para deixar de receber avisos. */
const PALAVRAS_OPTOUT = new Set(['SAIR', 'PARAR', 'STOP', 'CANCELAR', 'DESCADASTRAR']);
function ehPedidoOptOut(texto) {
  const t = String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toUpperCase().replace(/[^A-Z]/g, '');
  return PALAVRAS_OPTOUT.has(t);
}

module.exports = {
  TEMPORARIO,
  PERMANENTE,
  requisicaoJson,
  classificarHttp,
  iguaisSeguro,
  validarTokenQuery,
  ehPedidoOptOut,
};
