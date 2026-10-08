// src/services/emailService.js
const nodemailer = require('nodemailer');
const config = require('../config/emailConfig');

// ─────────────────────────────────────────
// Transporter com pool (criado sob demanda, reaproveitado entre envios)
// ─────────────────────────────────────────
let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_REMETENTE,
        pass: process.env.SENHA_APP,
      },
      pool:              config.smtp.pool,
      maxConnections:    config.smtp.maxConnections,
      maxMessages:       config.smtp.maxMessages,
      connectionTimeout: config.smtp.connectionTimeout,
      greetingTimeout:   config.smtp.greetingTimeout,
      socketTimeout:     config.smtp.socketTimeout,
    });
  }
  return transporter;
}

/** Fecha as conexões do pool SMTP (usado no shutdown do worker). */
function fecharTransporter() {
  if (transporter) {
    transporter.close();
    transporter = null;
  }
}

/**
 * Envia um e-mail. Rejeita com o erro original do Nodemailer
 * (o worker é quem classifica e decide retry/FAILED).
 */
async function enviarEmailNotificacao(destinatario, assunto, mensagem) {
  return getTransporter().sendMail({
    from: process.env.EMAIL_REMETENTE,
    to: destinatario,
    subject: assunto,
    text: mensagem,
  });
}

// ─────────────────────────────────────────
// Classificação de erros
// ─────────────────────────────────────────
const TEMPORARIO = 'TEMPORARIO';
const PERMANENTE = 'PERMANENTE';

// Erros de rede/socket: o servidor pode voltar.
const CODIGOS_REDE = new Set([
  'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNRESET', 'ECONNREFUSED',
  'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EPROTOCOL',
]);

/**
 * Classifica um erro de envio em TEMPORARIO ou PERMANENTE.
 *
 * Regras (em ordem):
 *  1. EAUTH → TEMPORARIO. É problema de configuração do SISTEMA (senha de app
 *     inválida/ausente), não do job. Marcar FAILED perderia e-mails legítimos
 *     por um erro do operador. O limite de tentativas continua valendo.
 *  2. EENVELOPE / EMESSAGE → PERMANENTE. Destinatário ou mensagem inválidos:
 *     reenviar o mesmo conteúdo sempre falhará.
 *  3. Código de resposta SMTP (RFC 5321): 4xx = falha transitória,
 *     5xx = falha permanente (ex.: 550 caixa inexistente, 553 endereço inválido).
 *  4. Erros de rede/timeout → TEMPORARIO.
 *  5. Desconhecido → TEMPORARIO (seguro, pois o retry é limitado).
 */
function classificarErro(err) {
  if (!err) return TEMPORARIO;
  if (err.permanente === true) return PERMANENTE;
  if (err.code === 'EAUTH') return TEMPORARIO;
  if (err.code === 'EENVELOPE' || err.code === 'EMESSAGE') return PERMANENTE;

  const rc = Number(err.responseCode);
  if (rc >= 400 && rc < 500) return TEMPORARIO;
  if (rc >= 500 && rc < 600) return PERMANENTE;

  if (CODIGOS_REDE.has(err.code)) return TEMPORARIO;
  return TEMPORARIO;
}

/**
 * Gera mensagem de erro segura para gravar no banco:
 * sem quebras de linha, sem stack trace, sem credenciais, com tamanho limitado.
 */
function sanitizarErro(err, maxLen = 500) {
  const partes = [];
  if (err && err.code) partes.push(`[${err.code}]`);
  if (err && err.responseCode) partes.push(`(${err.responseCode})`);
  partes.push((err && err.message) ? String(err.message) : 'Erro desconhecido');

  let texto = partes.join(' ').replace(/\s+/g, ' ').trim();

  for (const segredo of [process.env.SENHA_APP, process.env.DB_PASSWORD]) {
    if (segredo && segredo.length >= 4) texto = texto.split(segredo).join('***');
  }
  return texto.length > maxLen ? `${texto.slice(0, maxLen - 3)}...` : texto;
}

// Validação simples de formato. Não substitui a validação do servidor SMTP,
// mas evita gastar 5 tentativas num endereço obviamente inválido.
const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function emailValido(email) {
  return typeof email === 'string' && email.length <= 254 && REGEX_EMAIL.test(email);
}

module.exports = {
  enviarEmailNotificacao,
  fecharTransporter,
  classificarErro,
  sanitizarErro,
  emailValido,
  TEMPORARIO,
  PERMANENTE,
};
