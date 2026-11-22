// src/providers/whatsapp/fakeProvider.js
// Provider falso para desenvolvimento e testes: não chama rede, só registra.
// O webhook aceita o MESMO formato da Meta (útil para simular entregas/leituras via curl),
// autenticado por ?token=WHATSAPP_VERIFY_TOKEN.
const { classificarHttp, validarTokenQuery } = require('./comum');
const { parsearWebhook } = require('./metaCloudProvider');
const { mascararTelefone } = require('../../utils/telefone');

function criarFakeProvider(cfg, { logger = console } = {}) {
  const enviados = [];
  let seq = 0;

  async function enviar(job) {
    const providerMsgId = `fake-${Date.now()}-${++seq}`;
    enviados.push({ ...job, providerMsgId });
    logger.log(`[WhatsApp:fake] → ${mascararTelefone(job.destinatario)} (${job.template}) id=${providerMsgId}`);
    return { providerMsgId };
  }

  return {
    nome: 'fake',
    enviar,
    classificarErro: classificarHttp,
    validarWebhook: (req) => validarTokenQuery(req, cfg.verifyToken),
    parsearWebhook,
    enviados,
  };
}

module.exports = { criarFakeProvider };
