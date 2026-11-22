// src/providers/whatsapp/index.js
// Factory do provider de WhatsApp (padrão Adapter).
// Todos os providers expõem a mesma interface:
//   enviar(job)            → Promise<{ providerMsgId }>
//   classificarErro(err)   → 'TEMPORARIO' | 'PERMANENTE'
//   validarWebhook(req)    → boolean
//   parsearWebhook(body)   → Array<{ tipo: 'status'|'mensagem', ... }>
const defaultConfig = require('../../config/whatsappConfig');
const { criarMetaProvider } = require('./metaCloudProvider');
const { criarEvolutionProvider } = require('./evolutionProvider');
const { criarWahaProvider } = require('./wahaProvider');
const { criarFakeProvider } = require('./fakeProvider');

function criarProvider(nome = defaultConfig.provider, cfg = defaultConfig, opcoes = {}) {
  switch (nome) {
    case 'meta': return criarMetaProvider(cfg);
    case 'evolution': return criarEvolutionProvider(cfg);
    case 'waha': return criarWahaProvider(cfg);
    case 'fake': return criarFakeProvider(cfg, opcoes);
    default: throw new Error(`WHATSAPP_PROVIDER desconhecido: "${nome}" (use waha | meta | evolution | fake)`);
  }
}

let instancia = null;
/** Provider único do processo, conforme WHATSAPP_PROVIDER. */
function getProvider() {
  if (!instancia) instancia = criarProvider();
  return instancia;
}

module.exports = { criarProvider, getProvider };
