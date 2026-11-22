// src/providers/whatsapp/wahaProvider.js
// WAHA (WhatsApp HTTP API — waha-core)
// Suporta envio de mensagens, verificação de existência de número (resolvendo 9º dígito BR),
// webhooks (message.ack e message com HMAC ou token) e gerenciamento de sessão/QR Code.
const crypto = require('crypto');
const { TEMPORARIO, PERMANENTE, requisicaoJson, classificarHttp, iguaisSeguro, validarTokenQuery } = require('./comum');
const { variantesBR } = require('../../utils/telefone');

const MAPA_ACK = {
  1: 'sent',      // WAMessageAck.SERVER
  2: 'delivered', // WAMessageAck.DEVICE
  3: 'read',      // WAMessageAck.READ
  4: 'read',      // WAMessageAck.PLAYED
  [-1]: 'failed', // WAMessageAck.ERROR
  SERVER: 'sent',
  DEVICE: 'delivered',
  READ: 'read',
  PLAYED: 'read',
  ERROR: 'failed',
};

/**
 * Normaliza o ID da mensagem para o ID curto do WhatsApp (ex.: `3EB012345`), que é igual em
 * todos os formatos que o WAHA devolve:
 *  - NOWEB `/api/sendText` → mensagem crua do Baileys `{ key: { id, remoteJid, fromMe } }`
 *  - WEBJS `/api/sendText` → `{ id: { fromMe, remote, id, _serialized } }` ou `{ id: 'true_...' }`
 *  - Webhook `message.ack` → `payload.id = 'true_5511...@c.us_3EB012345[_participant]'`
 * Comparar pelo ID curto evita divergências de formato do chatId (@c.us / @s.whatsapp.net / @lid).
 */
function extrairIdMensagem(valor) {
  if (!valor) return null;
  if (typeof valor === 'object') {
    if (valor.key?.id) return String(valor.key.id);
    if (valor.id) return extrairIdMensagem(valor.id);
    if (valor._serialized) return extrairIdMensagem(valor._serialized);
    return null;
  }
  const s = String(valor);
  const partes = s.split('_');
  // Formato serializado: fromMe_chatId_id[_participant]
  if (partes.length >= 3 && (partes[0] === 'true' || partes[0] === 'false')) return partes[2] || null;
  return s;
}

/** Valida X-Webhook-Hmac (SHA-512 ou SHA-256) enviado pelo WebhookSender do WAHA. */
function verificarHmacWaha(rawBody, assinatura, algoritmo = 'sha512', segredo) {
  if (!segredo || !rawBody || !assinatura) return false;
  const alg = ['sha512', 'sha256'].includes(String(algoritmo).toLowerCase())
    ? String(algoritmo).toLowerCase()
    : 'sha512';
  const esperado = crypto.createHmac(alg, segredo).update(rawBody).digest('hex');
  return iguaisSeguro(assinatura, esperado);
}

/**
 * Converte o payload de webhook do WAHA (`WAHAWebhook`) em eventos neutros do GPE:
 *  { tipo: 'status',   providerMsgId, status: 'sent'|'delivered'|'read'|'failed', erro? }
 *  { tipo: 'mensagem', de: '5511999998888', texto }
 */
function parsearWebhook(body) {
  const evento = String(body?.event || '').toLowerCase();
  const p = body?.payload || {};
  const eventos = [];

  if (evento === 'message.ack') {
    const status = MAPA_ACK[p.ack] ?? MAPA_ACK[String(p.ackName || '').toUpperCase()];
    const id = extrairIdMensagem(p.id);
    if (status && id) {
      eventos.push({
        tipo: 'status',
        providerMsgId: id,
        status,
        erro: status === 'failed' ? '[WAHA] Falha de entrega reportada pelo ACK' : undefined,
      });
    }
  } else if (evento === 'message' || evento === 'message.any') {
    if (!p.fromMe && p.from) {
      const fromStr = String(p.from);
      // Ignora grupos (@g.us) e canais (@newsletter)
      if (fromStr.endsWith('@c.us') || fromStr.endsWith('@s.whatsapp.net') || /^\d+$/.test(fromStr)) {
        const de = fromStr.split('@')[0].replace(/\D/g, '');
        const texto = p.body ?? p.text ?? p._data?.body ?? '';
        if (de) eventos.push({ tipo: 'mensagem', de, texto });
      }
    }
  }

  return eventos;
}

function criarWahaProvider(cfg) {
  const { url, apiKey, session, hmacSecret, checkNumberExists } = cfg.waha || {};
  const headersPadrao = apiKey ? { 'X-Api-Key': apiKey } : {};

  /**
   * Resolve o chatId (`5511999998888@c.us`) consultando `/api/contacts/check-exists` quando habilitado.
   * No Brasil, contas antigas do WhatsApp não têm o 9º dígito no JID; o `check-exists` do WAHA
   * já devolve o `chatId` exato registrado nos servidores do WhatsApp!
   */
  async function resolverChatId(destinatario) {
    const digitos = String(destinatario).replace(/\D/g, '');
    if (!checkNumberExists) {
      return `${digitos}@c.us`;
    }

    const candidatos = variantesBR(destinatario).map(v => String(v).replace(/\D/g, ''));
    let ultimaResp = null;

    for (const fone of candidatos) {
      const qs = new URLSearchParams({ phone: fone, session });
      const resp = await requisicaoJson(`${url}/api/contacts/check-exists?${qs.toString()}`, {
        method: 'GET',
        headers: headersPadrao,
        timeoutMs: cfg.httpTimeoutMs,
      });
      ultimaResp = resp;
      if (resp && resp.numberExists !== false) {
        return resp?.chatId || `${fone}@c.us`;
      }
    }

    throw Object.assign(new Error(`[WAHA] Número ${digitos} não possui conta WhatsApp ativa`), {
      status: 400,
      permanente: true,
      corpo: ultimaResp,
    });
  }

  async function enviar(job) {
    if (!url) {
      throw Object.assign(new Error('WAHA não configurado (WAHA_URL)'), { code: 'ECONFIG' });
    }

    try {
      const chatId = await resolverChatId(job.destinatario);
      const resp = await requisicaoJson(`${url}/api/sendText`, {
        method: 'POST',
        headers: headersPadrao,
        body: {
          session,
          chatId,
          text: job.mensagem,
        },
        timeoutMs: cfg.httpTimeoutMs,
      });

      return { providerMsgId: extrairIdMensagem(resp) };
    } catch (err) {
      const detalhe = err.corpo?.message || err.corpo?.error || err.corpo?.exception;
      if (detalhe && !err.message.includes('[WAHA')) {
        err.message = `[WAHA ${err.status || err.code || 'ERR'}] ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe)}`.slice(0, 400);
      }
      throw err;
    }
  }

  function classificarErro(err) {
    if (err?.code === 'ECONFIG') return TEMPORARIO;
    if (err?.permanente === true) return PERMANENTE;
    // Sessão ainda não pareada ou parada no WAHA (422 Unprocessable Entity: Session status is not as expected)
    if (Number(err?.status) === 422 && /session|status|working/i.test(JSON.stringify(err.corpo || err.message || ''))) {
      return TEMPORARIO;
    }
    return classificarHttp(err);
  }

  let avisouWebhookAberto = false;

  function validarWebhook(req) {
    // 1. HMAC configurado → obrigatório (sem fallback para token ou aceite livre)
    if (hmacSecret) {
      const assinatura = req.get?.('x-webhook-hmac');
      return verificarHmacWaha(req.rawBody, assinatura, req.get?.('x-webhook-hmac-algorithm'), hmacSecret);
    }
    // 2. Token simples (header X-Webhook-Token ou ?token=)
    if (cfg.verifyToken) {
      const tokenHeader = req.get?.('x-webhook-token');
      if (tokenHeader && iguaisSeguro(tokenHeader, cfg.verifyToken)) return true;
      return validarTokenQuery(req, cfg.verifyToken);
    }
    // 3. Nenhum segredo: só aceita fora de produção (dev local)
    if (process.env.NODE_ENV === 'production') return false;
    if (!avisouWebhookAberto) {
      avisouWebhookAberto = true;
      console.warn('[WAHA] Webhook sem WAHA_HMAC_SECRET/WHATSAPP_VERIFY_TOKEN: aceitando requisições (somente fora de produção).');
    }
    return true;
  }

  // ── Gerenciamento de Sessão e QR Code (usado pelo Painel do Gestor) ──

  async function obterStatusSessao() {
    try {
      const info = await requisicaoJson(`${url}/api/sessions/${encodeURIComponent(session)}`, {
        method: 'GET',
        headers: headersPadrao,
        timeoutMs: 5_000,
      });
      return {
        online: true,
        session: info?.name || session,
        status: info?.status || 'STOPPED',
        me: info?.me || null,
        engine: info?.engine?.engine || null,
      };
    } catch (err) {
      if (Number(err?.status) === 404) {
        return { online: true, session, status: 'STOPPED', me: null };
      }
      return {
        online: false,
        session,
        status: 'OFFLINE',
        erro: err.message,
      };
    }
  }

  async function iniciarSessao({ webhookUrl } = {}) {
    const configSessao = webhookUrl
      ? {
        webhooks: [
          {
            url: webhookUrl,
            events: ['message', 'message.ack'],
            ...(hmacSecret ? { hmac: { key: hmacSecret } } : {}),
          },
        ],
      }
      : undefined;

    // Verifica se a sessão já existe
    const atual = await obterStatusSessao();
    if (!atual.online) {
      throw new Error(`Servidor WAHA inacessível em ${url}. Certifique-se de que o waha-core está rodando.`);
    }

    if (atual.status === 'WORKING' || atual.status === 'SCAN_QR_CODE' || atual.status === 'STARTING') {
      return atual;
    }

    if (atual.status === 'FAILED') {
      const reiniciado = await requisicaoJson(`${url}/api/sessions/${encodeURIComponent(session)}/restart`, {
        method: 'POST',
        headers: headersPadrao,
        timeoutMs: 10_000,
      });
      return { online: true, session: reiniciado?.name || session, status: reiniciado?.status || 'STARTING', me: reiniciado?.me || null };
    }

    // Cria (ou atualiza) e inicia a sessão
    try {
      const criado = await requisicaoJson(`${url}/api/sessions`, {
        method: 'POST',
        headers: headersPadrao,
        body: { name: session, start: true, ...(configSessao ? { config: configSessao } : {}) },
        timeoutMs: 10_000,
      });
      return { online: true, session: criado?.name || session, status: criado?.status || 'STARTING', me: criado?.me || null };
    } catch (err) {
      // Se já existe (422 / 409), apenas dá start
      const iniciado = await requisicaoJson(`${url}/api/sessions/${encodeURIComponent(session)}/start`, {
        method: 'POST',
        headers: headersPadrao,
        timeoutMs: 10_000,
      });
      return { online: true, session: iniciado?.name || session, status: iniciado?.status || 'STARTING', me: iniciado?.me || null };
    }
  }

  async function obterQrCode() {
    const resp = await requisicaoJson(`${url}/api/${encodeURIComponent(session)}/auth/qr?format=image`, {
      method: 'GET',
      headers: { ...headersPadrao, Accept: 'application/json' },
      timeoutMs: 8_000,
    });
    // Com Accept: application/json, o BufferResponseInterceptor do WAHA retorna { mimetype: 'image/png', data: '<base64>' }
    if (resp?.data) {
      const mime = resp.mimetype || 'image/png';
      return { dataUrl: `data:${mime};base64,${resp.data}` };
    }
    if (resp?.value) {
      return { raw: resp.value };
    }
    return resp;
  }

  async function desconectarSessao() {
    try {
      await requisicaoJson(`${url}/api/sessions/${encodeURIComponent(session)}/logout`, {
        method: 'POST',
        headers: headersPadrao,
        timeoutMs: 8_000,
      });
    } catch (_) { /* ignore if already logged out */ }
    try {
      await requisicaoJson(`${url}/api/sessions/${encodeURIComponent(session)}/stop`, {
        method: 'POST',
        headers: headersPadrao,
        timeoutMs: 8_000,
      });
    } catch (_) { /* ignore */ }
    return { desconectado: true };
  }

  return {
    nome: 'waha',
    enviar,
    classificarErro,
    validarWebhook,
    parsearWebhook,
    obterStatusSessao,
    iniciarSessao,
    obterQrCode,
    desconectarSessao,
  };
}

module.exports = { criarWahaProvider, parsearWebhook, verificarHmacWaha, extrairIdMensagem };

