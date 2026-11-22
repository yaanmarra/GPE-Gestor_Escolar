// src/providers/whatsapp/evolutionProvider.js
// Evolution API (self-hosted) — modo Baileys / QR Code.
//
// ⚠️ NÃO-OFICIAL: viola os termos do WhatsApp e o número pode ser banido.
// Use apenas em desenvolvimento/PoC. Em produção, use WHATSAPP_PROVIDER=meta.
const { TEMPORARIO, PERMANENTE, requisicaoJson, classificarHttp, validarTokenQuery } = require('./comum');

const MAPA_STATUS = {
  SERVER_ACK: 'sent',
  DELIVERY_ACK: 'delivered',
  READ: 'read',
  PLAYED: 'read',
  ERROR: 'failed',
};

function textoDaMensagem(message) {
  return message?.conversation
    ?? message?.extendedTextMessage?.text
    ?? message?.buttonsResponseMessage?.selectedDisplayText
    ?? '';
}

/** Converte o webhook da Evolution (v2) em eventos neutros (mesmo formato do provider Meta). */
function parsearWebhook(body) {
  const evento = String(body?.event || '').toLowerCase().replace(/_/g, '.');
  const itens = Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
  const eventos = [];

  if (evento === 'messages.update') {
    for (const d of itens) {
      const status = MAPA_STATUS[String(d.status || '').toUpperCase()];
      const id = d.keyId || d.key?.id;
      if (status && id) eventos.push({ tipo: 'status', providerMsgId: id, status });
    }
  } else if (evento === 'messages.upsert') {
    for (const d of itens) {
      if (d.key?.fromMe) continue;
      const jid = d.key?.remoteJid || '';
      if (!jid.endsWith('@s.whatsapp.net')) continue; // ignora grupos
      eventos.push({ tipo: 'mensagem', de: jid.split('@')[0], texto: textoDaMensagem(d.message) });
    }
  }
  return eventos;
}

function criarEvolutionProvider(cfg) {
  const { url, apiKey, instance } = cfg.evolution;

  async function enviar(job) {
    if (!apiKey) {
      throw Object.assign(new Error('Evolution API não configurada (EVOLUTION_API_KEY)'), { code: 'ECONFIG' });
    }
    try {
      const resp = await requisicaoJson(`${url}/message/sendText/${encodeURIComponent(instance)}`, {
        headers: { apikey: apiKey },
        body: { number: String(job.destinatario).replace(/\D/g, ''), text: job.mensagem },
        timeoutMs: cfg.httpTimeoutMs,
      });
      return { providerMsgId: resp?.key?.id || null };
    } catch (err) {
      const detalhe = err.corpo?.response?.message ?? err.corpo?.message;
      if (detalhe) err.message = `[Evolution ${err.status}] ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe)}`.slice(0, 400);
      throw err;
    }
  }

  function classificarErro(err) {
    if (err?.code === 'ECONFIG') return TEMPORARIO;
    // Número sem WhatsApp: Evolution responde 400 com {"exists": false}
    if (Number(err?.status) === 400 && /exists["']?\s*:\s*false/i.test(JSON.stringify(err.corpo || ''))) return PERMANENTE;
    return classificarHttp(err);
  }

  return {
    nome: 'evolution',
    enviar,
    classificarErro,
    validarWebhook: (req) => validarTokenQuery(req, cfg.verifyToken),
    parsearWebhook,
  };
}

module.exports = { criarEvolutionProvider, parsearWebhook };
