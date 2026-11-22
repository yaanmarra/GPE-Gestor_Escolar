// src/providers/whatsapp/metaCloudProvider.js
// WhatsApp Business Platform — Cloud API oficial da Meta.
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
//
// Mensagens iniciadas pela escola PRECISAM ser templates aprovados (categoria UTILITY).
const crypto = require('crypto');
const { parametrosPosicionais } = require('../../services/whatsappTemplates');
const { TEMPORARIO, PERMANENTE, requisicaoJson, classificarHttp, iguaisSeguro } = require('./comum');

// Códigos de erro da Cloud API (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)
const CODIGOS_PERMANENTES = new Set([
  100,    // parâmetro inválido
  131008, // parâmetro obrigatório ausente
  131009, // valor de parâmetro inválido
  131026, // destinatário sem WhatsApp / não pode receber
  131051, // tipo de mensagem não suportado
  132000, // nº de parâmetros não bate com o template
  132001, // template não existe / não aprovado no idioma
  132005, // texto do template grande demais após substituição
  132007, // template viola política de formato
  132012, // formato de parâmetro inválido
  132015, // template pausado
  132016, // template desativado
]);
const CODIGOS_TEMPORARIOS = new Set([
  1, 2, 4, 80007,  // erro/limite genérico da API
  130429,          // rate limit de throughput
  131000,          // erro interno
  131016,          // serviço indisponível
  131048,          // limite anti-spam
  131056,          // muitas mensagens para o mesmo destinatário
  133004,          // servidor temporariamente indisponível
  190,             // token expirado/inválido → config do sistema (alerta ao operador)
]);

/** Valida X-Hub-Signature-256 = "sha256=" + HMAC_SHA256(appSecret, rawBody). */
function verificarAssinatura(rawBody, cabecalho, appSecret) {
  if (!appSecret || !rawBody || !cabecalho) return false;
  const esperado = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return iguaisSeguro(cabecalho, esperado);
}

const MAPA_STATUS = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };

/**
 * Converte o payload do webhook em eventos neutros:
 *  { tipo: 'status',   providerMsgId, status: 'sent'|'delivered'|'read'|'failed', erro? }
 *  { tipo: 'mensagem', de: '5511999998888', texto }
 */
function parsearWebhook(body) {
  const eventos = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      for (const s of value.statuses || []) {
        const status = MAPA_STATUS[s.status];
        if (!status || !s.id) continue;
        const e = s.errors?.[0];
        eventos.push({
          tipo: 'status',
          providerMsgId: s.id,
          status,
          erro: e ? `[Meta ${e.code}] ${e.title || e.message || ''}`.trim() : undefined,
        });
      }
      for (const m of value.messages || []) {
        const texto = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? '';
        if (m.from) eventos.push({ tipo: 'mensagem', de: m.from, texto });
      }
    }
  }
  return eventos;
}

function criarMetaProvider(cfg) {
  const { phoneNumberId, token, appSecret, graphVersion, idioma } = cfg.meta;

  async function enviar(job) {
    if (!phoneNumberId || !token) {
      throw Object.assign(new Error('Meta Cloud API não configurada (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TOKEN)'), { code: 'ECONFIG' });
    }
    const variaveis = typeof job.variaveis === 'string' ? JSON.parse(job.variaveis) : job.variaveis;
    const parametros = parametrosPosicionais(job.template, variaveis);

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: String(job.destinatario).replace(/\D/g, ''),
      type: 'template',
      template: {
        name: job.template,
        language: { code: idioma },
        components: parametros.length
          ? [{ type: 'body', parameters: parametros.map((text) => ({ type: 'text', text })) }]
          : [],
      },
    };

    try {
      const resp = await requisicaoJson(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
        body,
        timeoutMs: cfg.httpTimeoutMs,
      });
      return { providerMsgId: resp?.messages?.[0]?.id || null };
    } catch (err) {
      const e = err.corpo?.error;
      if (e) {
        err.codigo = Number(e.code);
        err.message = `[Meta ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''}] ${e.message || ''}`.trim();
      }
      throw err;
    }
  }

  function classificarErro(err) {
    if (err?.code === 'ECONFIG') return TEMPORARIO;
    const c = Number(err?.codigo);
    if (CODIGOS_PERMANENTES.has(c)) return PERMANENTE;
    if (CODIGOS_TEMPORARIOS.has(c)) return TEMPORARIO;
    return classificarHttp(err);
  }

  function validarWebhook(req) {
    return verificarAssinatura(req.rawBody, req.get('x-hub-signature-256'), appSecret);
  }

  return { nome: 'meta', enviar, classificarErro, validarWebhook, parsearWebhook };
}

module.exports = { criarMetaProvider, verificarAssinatura, parsearWebhook };
