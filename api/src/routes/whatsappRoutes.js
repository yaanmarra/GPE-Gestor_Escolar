// src/routes/whatsappRoutes.js
// Endpoints de WhatsApp:
//  - Webhook público (Meta Cloud API / Evolution API / Fake):
//      GET  /api/webhooks/whatsapp (verificação de desafio da Meta)
//      POST /api/webhooks/whatsapp (status de entrega/leitura e opt-out "SAIR")
//  - Configuração e Consentimento LGPD do Responsável (Pai):
//      GET  /api/whatsapp/preferencias
//      PUT  /api/whatsapp/preferencias
//      POST /api/whatsapp/teste
//  - Painel de Monitoramento do Gestor:
//      GET  /api/whatsapp/jobs

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { sucesso, erro } = require('../utils/resposta');
const { autenticar, autorizar } = require('../middlewares/auth');
const defaultWaConfig = require('../config/whatsappConfig');
const { getProvider } = require('../providers/whatsapp');
const { iguaisSeguro, ehPedidoOptOut } = require('../providers/whatsapp/comum');
const { normalizarTelefoneBR, variantesBR, mascararTelefone } = require('../utils/telefone');
const { montarTesteConexao } = require('../services/whatsappTemplates');

function getDbPromise() {
  return require('../config/database').dbPromise;
}

// Ordem de progressão monotônica de entrega (evita que 'sent' atrasado sobrescreva 'read')
const ORDEM_ENTREGA = { sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * Processa eventos já parseados pelo provider (puro sobre `db`, fácil de testar).
 * @returns {Promise<{ statusAtualizados: number, optouts: number }>}
 */
async function processarEventosWebhook(db, eventos) {
  let statusAtualizados = 0;
  let optouts = 0;

  for (const ev of eventos) {
    if (ev.tipo === 'status' && ev.providerMsgId && ev.status) {
      const [[atual]] = await db.query(
        'SELECT id, status_entrega FROM whatsapp_jobs WHERE provider_msg_id = ? LIMIT 1',
        [ev.providerMsgId]
      );
      if (!atual) continue;

      const nivelAtual = ORDEM_ENTREGA[atual.status_entrega] || 0;
      const nivelNovo = ORDEM_ENTREGA[ev.status] || 0;
      if (nivelNovo < nivelAtual && ev.status !== 'failed') continue;

      await db.query(
        `UPDATE whatsapp_jobs
            SET status_entrega = ?,
                entregue_em = IF(? IN ('delivered', 'read') AND entregue_em IS NULL, NOW(), entregue_em),
                lido_em     = IF(? = 'read' AND lido_em IS NULL, NOW(), lido_em),
                ultimo_erro = COALESCE(?, ultimo_erro)
          WHERE id = ?`,
        [ev.status, ev.status, ev.status, ev.erro || null, atual.id]
      );
      statusAtualizados++;
    } else if (ev.tipo === 'mensagem' && ev.de && ehPedidoOptOut(ev.texto)) {
      const variantes = variantesBR(ev.de);
      const [r] = await db.query(
        `UPDATE pais
            SET whatsapp_optin = 0, whatsapp_optout_em = NOW()
          WHERE telefone_e164 IN (?) AND whatsapp_optin = 1`,
        [variantes]
      );
      if (r.affectedRows > 0) {
        optouts += r.affectedRows;
        // Cancela eventuais envios na fila ainda não disparados para este número
        await db.query(
          `UPDATE whatsapp_jobs
              SET status = 'CANCELLED', ultimo_erro = 'Opt-out solicitado pelo responsável via WhatsApp', processado_em = NOW()
            WHERE destinatario IN (?) AND status IN ('PENDING', 'RETRY')`,
          [variantes]
        );
      }
    }
  }

  return { statusAtualizados, optouts };
}

// ─────────────────────────────────────────
// GET /api/webhooks/whatsapp — Verificação Meta (hub.challenge)
// ─────────────────────────────────────────
router.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && defaultWaConfig.verifyToken && iguaisSeguro(token, defaultWaConfig.verifyToken)) {
    return res.status(200).type('text/plain').send(String(challenge ?? ''));
  }
  return res.status(403).json({ sucesso: false, erro: 'Falha na verificação do webhook.' });
});

// ─────────────────────────────────────────
// POST /api/webhooks/whatsapp — Eventos de status e mensagens recebidas
// ─────────────────────────────────────────
router.post('/webhooks/whatsapp', async (req, res) => {
  const provider = getProvider();
  if (!provider.validarWebhook(req)) {
    return erro(res, 'Assinatura ou token de webhook inválido.', 401);
  }

  try {
    const eventos = provider.parsearWebhook(req.body || {});
    const resultado = await processarEventosWebhook(getDbPromise(), eventos);
    return sucesso(res, { recebido: true, ...resultado });
  } catch (e) {
    console.error('[Webhook WhatsApp] Erro ao processar:', e.message);
    return erro(res, 'Erro ao processar webhook.', 500);
  }
});

// ─────────────────────────────────────────
// GET /api/whatsapp/preferencias — Consultar dados de WhatsApp do responsável logado
// ─────────────────────────────────────────
router.get('/whatsapp/preferencias', autenticar, autorizar('pai', 'gestor'), async (req, res) => {
  const dbPromise = getDbPromise();
  const usuarioId = req.usuario.tipo === 'gestor' && req.query.usuario_id
    ? Number(req.query.usuario_id)
    : req.usuario.id;

  try {
    const [[pai]] = await dbPromise.query(
      `SELECT p.id AS pai_id, u.nome, p.telefone, p.telefone_e164,
              p.whatsapp_optin, p.whatsapp_optin_em, p.whatsapp_optin_origem, p.whatsapp_optout_em
         FROM pais p
         JOIN usuarios u ON u.id = p.usuario_id
        WHERE p.usuario_id = ? LIMIT 1`,
      [usuarioId]
    );
    if (!pai) return erro(res, 'Cadastro de responsável não encontrado.', 404);

    const [prefs] = await dbPromise.query(
      'SELECT tipo, canal, ativo FROM notificacao_preferencias WHERE pai_id = ?',
      [pai.pai_id]
    );

    const prefFaltaWa = prefs.find(p => p.tipo === 'falta' && p.canal === 'whatsapp');

    return sucesso(res, {
      whatsappHabilitadoServidor: defaultWaConfig.enabled,
      provider: defaultWaConfig.provider,
      telefone: pai.telefone || '',
      telefone_e164: pai.telefone_e164 || null,
      whatsapp_optin: Boolean(pai.whatsapp_optin && !pai.whatsapp_optout_em),
      whatsapp_optin_em: pai.whatsapp_optin_em,
      whatsapp_optout_em: pai.whatsapp_optout_em,
      aviso_falta_ativo: prefFaltaWa ? Boolean(prefFaltaWa.ativo) : true,
    });
  } catch (e) {
    return erro(res, 'Erro ao buscar preferências de WhatsApp.', 500);
  }
});

// ─────────────────────────────────────────
// PUT /api/whatsapp/preferencias — Atualizar telefone, consentimento LGPD e preferências
// ─────────────────────────────────────────
router.put('/whatsapp/preferencias', autenticar, autorizar('pai', 'gestor'), async (req, res) => {
  const dbPromise = getDbPromise();
  const { telefone, whatsapp_optin, aviso_falta_ativo, usuario_id } = req.body || {};
  const alvoUsuarioId = req.usuario.tipo === 'gestor' && usuario_id ? Number(usuario_id) : req.usuario.id;
  const origem = req.usuario.tipo === 'gestor' ? 'secretaria' : 'painel_pais';

  try {
    const [[pai]] = await dbPromise.query(
      'SELECT id, telefone, telefone_e164, whatsapp_optin FROM pais WHERE usuario_id = ? LIMIT 1',
      [alvoUsuarioId]
    );
    if (!pai) return erro(res, 'Cadastro de responsável não encontrado.', 404);

    let foneBruto = telefone !== undefined ? String(telefone).trim() : (pai.telefone || '');
    let foneE164 = foneBruto ? normalizarTelefoneBR(foneBruto) : null;

    if (foneBruto && !foneE164) {
      return erro(res, 'Número de celular inválido. Informe DDD + 9 dígitos (ex.: 11 99999-8888).', 400);
    }

    const querOptin = whatsapp_optin !== undefined ? Boolean(whatsapp_optin) : Boolean(pai.whatsapp_optin);
    if (querOptin && !foneE164) {
      return erro(res, 'Para ativar os avisos via WhatsApp, informe um número de celular válido.', 400);
    }

    if (querOptin) {
      await dbPromise.query(
        `UPDATE pais
            SET telefone = ?,
                telefone_e164 = ?,
                whatsapp_optin = 1,
                whatsapp_optin_em = NOW(),
                whatsapp_optin_origem = ?,
                whatsapp_optout_em = NULL
          WHERE id = ?`,
        [foneBruto || null, foneE164, origem, pai.id]
      );
    } else {
      // Atenção: o MySQL avalia as atribuições da esquerda para a direita — whatsapp_optout_em
      // precisa vir ANTES de whatsapp_optin = 0, senão o IF já enxerga o valor novo (0).
      await dbPromise.query(
        `UPDATE pais
            SET telefone = ?,
                telefone_e164 = ?,
                whatsapp_optout_em = IF(whatsapp_optin = 1, NOW(), whatsapp_optout_em),
                whatsapp_optin = 0
          WHERE id = ?`,
        [foneBruto || null, foneE164, pai.id]
      );
      // Cancela envios pendentes caso o responsável tenha desativado o consentimento
      await dbPromise.query(
        `UPDATE whatsapp_jobs
            SET status = 'CANCELLED', ultimo_erro = 'Consentimento revogado no painel', processado_em = NOW()
          WHERE usuario_id = ? AND status IN ('PENDING', 'RETRY')`,
        [alvoUsuarioId]
      );
    }

    if (aviso_falta_ativo !== undefined) {
      const ativo = aviso_falta_ativo ? 1 : 0;
      await dbPromise.query(
        `INSERT INTO notificacao_preferencias (pai_id, tipo, canal, ativo)
         VALUES (?, 'falta', 'whatsapp', ?)
         ON DUPLICATE KEY UPDATE ativo = VALUES(ativo)`,
        [pai.id, ativo]
      );
    }

    return sucesso(res, {
      mensagem: querOptin
        ? 'Preferências salvas! Você receberá avisos de frequência pelo WhatsApp.'
        : 'Preferências atualizadas. Envios via WhatsApp desativados.',
      telefone_e164: foneE164,
      whatsapp_optin: querOptin,
    });
  } catch (e) {
    return erro(res, 'Erro ao atualizar preferências de WhatsApp.', 500);
  }
});

// ─────────────────────────────────────────
// POST /api/whatsapp/teste — Envia ou enfileira mensagem de teste para o responsável
// Limite por usuário: cada teste é um envio real (evita spam e risco de banimento do número)
// ─────────────────────────────────────────
const limiteTeste = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `wa-teste:${req.usuario?.id}`,
  skip: () => process.env.NODE_ENV === 'test',
  message: { sucesso: false, erro: 'Limite de mensagens de teste atingido. Tente novamente em alguns minutos.' },
});

router.post('/whatsapp/teste', autenticar, autorizar('pai', 'gestor'), limiteTeste, async (req, res) => {
  const dbPromise = getDbPromise();

  try {
    let foneDestino = null;
    let nomeResp = req.usuario.nome || 'Gestor GPE';

    // Permite que o gestor envie um teste rápido informando qualquer número diretamente no painel
    if (req.usuario.tipo === 'gestor' && req.body?.telefone) {
      foneDestino = normalizarTelefoneBR(req.body.telefone);
      if (!foneDestino) {
        return erro(res, 'Número de celular inválido. Informe DDD + 9 dígitos (ex.: 11 99999-8888).', 400);
      }
    } else {
      const alvoUsuarioId = req.usuario.tipo === 'gestor' && req.body?.usuario_id
        ? Number(req.body.usuario_id)
        : req.usuario.id;

      const [[pai]] = await dbPromise.query(
        `SELECT p.id AS pai_id, u.nome AS nome_responsavel, p.telefone_e164, p.whatsapp_optin, p.whatsapp_optout_em
           FROM pais p
           JOIN usuarios u ON u.id = p.usuario_id
          WHERE p.usuario_id = ? LIMIT 1`,
        [alvoUsuarioId]
      );
      if (!pai) return erro(res, 'Cadastro de responsável não encontrado.', 404);
      if (!pai.telefone_e164) return erro(res, 'Cadastre um telefone válido antes de enviar um teste.', 400);
      if (!pai.whatsapp_optin || pai.whatsapp_optout_em) {
        return erro(res, 'Ative o consentimento de recebimento via WhatsApp antes de testar.', 400);
      }
      foneDestino = pai.telefone_e164;
      nomeResp = pai.nome_responsavel;
    }

    const { template, variaveis, mensagem } = montarTesteConexao(
      { nomeResponsavel: nomeResp },
      defaultWaConfig
    );

    const provider = getProvider();
    const resultado = await provider.enviar({
      destinatario: foneDestino,
      template,
      variaveis,
      mensagem,
    });

    return sucesso(res, {
      mensagem: `Mensagem de teste enviada para ${mascararTelefone(foneDestino)} via provider "${provider.nome}".`,
      provider: provider.nome,
      providerMsgId: resultado?.providerMsgId || null,
      texto: mensagem,
    });
  } catch (e) {
    return erro(res, `Falha ao enviar mensagem de teste: ${e.message}`, 502);
  }
});

// ─────────────────────────────────────────
// GET /api/whatsapp/jobs — Histórico e métricas de disparos (Painel do Gestor)
// ─────────────────────────────────────────
router.get('/whatsapp/jobs', autenticar, autorizar('gestor'), async (req, res) => {
  const dbPromise = getDbPromise();
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const statusFiltro = req.query.status ? String(req.query.status).toUpperCase() : null;

    const params = [];
    let where = '';
    if (statusFiltro) {
      where = 'WHERE w.status = ?';
      params.push(statusFiltro);
    }
    params.push(limit);

    const [jobs] = await dbPromise.query(
      `SELECT w.id, w.usuario_id, w.aluno_id, w.destinatario, w.template, w.mensagem,
              w.tipo_notificacao, w.data_referencia, w.status, w.tentativas, w.max_tentativas,
              w.ultimo_erro, w.criado_em, w.processado_em, w.enviar_apos,
              w.provider, w.provider_msg_id, w.status_entrega, w.entregue_em, w.lido_em,
              u_pai.nome AS nome_responsavel, u_aluno.nome AS nome_aluno
         FROM whatsapp_jobs w
         LEFT JOIN usuarios u_pai   ON u_pai.id = w.usuario_id
         LEFT JOIN alunos a         ON a.id = w.aluno_id
         LEFT JOIN usuarios u_aluno ON u_aluno.id = a.usuario_id
         ${where}
        ORDER BY w.id DESC
        LIMIT ?`,
      params
    );

    const [contagem] = await dbPromise.query(
      `SELECT status, COUNT(*) AS total FROM whatsapp_jobs GROUP BY status`
    );
    const [contagemEntrega] = await dbPromise.query(
      `SELECT status_entrega, COUNT(*) AS total FROM whatsapp_jobs WHERE status = 'SENT' GROUP BY status_entrega`
    );

    const resumo = { PENDING: 0, PROCESSING: 0, RETRY: 0, SENT: 0, FAILED: 0, CANCELLED: 0 };
    for (const c of contagem) resumo[c.status] = Number(c.total);

    const entregas = { sent: 0, delivered: 0, read: 0, failed: 0 };
    for (const c of contagemEntrega) {
      if (c.status_entrega) entregas[c.status_entrega] = Number(c.total);
    }

    return sucesso(res, {
      config: {
        enabled: defaultWaConfig.enabled,
        provider: defaultWaConfig.provider,
        janelaCorrecaoMin: defaultWaConfig.janelaCorrecaoMin,
        wahaUrl: defaultWaConfig.waha?.url,
        wahaSession: defaultWaConfig.waha?.session,
      },
      resumo,
      entregas,
      jobs: jobs.map(j => ({
        ...j,
        destinatario_mascarado: mascararTelefone(j.destinatario),
      })),
    });
  } catch (e) {
    return erro(res, 'Erro ao consultar fila de WhatsApp.', 500);
  }
});

// ─────────────────────────────────────────
// GERENCIAMENTO DE SESSÃO E QR CODE (WAHA) — Painel do Gestor
// ─────────────────────────────────────────
router.get('/whatsapp/sessao', autenticar, autorizar('gestor'), async (_req, res) => {
  const provider = getProvider();
  if (typeof provider.obterStatusSessao !== 'function') {
    return sucesso(res, {
      suportaSessao: false,
      provider: provider.nome,
      status: provider.nome === 'fake' ? 'SIMULADOR_FAKE' : 'EXTERNO',
    });
  }

  try {
    const status = await provider.obterStatusSessao();
    return sucesso(res, { suportaSessao: true, provider: provider.nome, ...status });
  } catch (e) {
    return erro(res, `Erro ao consultar sessão no WAHA: ${e.message}`, 502);
  }
});

router.post('/whatsapp/sessao/iniciar', autenticar, autorizar('gestor'), async (req, res) => {
  const provider = getProvider();
  if (typeof provider.iniciarSessao !== 'function') {
    return erro(res, `O provider atual ("${provider.nome}") não utiliza pareamento de sessão via QR Code.`, 400);
  }

  try {
    const port = process.env.PORT || 3000;
    const baseApiUrl = req.body?.webhookBaseUrl || `http://localhost:${port}`;
    const tokenQs = defaultWaConfig.verifyToken ? `?token=${encodeURIComponent(defaultWaConfig.verifyToken)}` : '';
    const webhookUrl = `${baseApiUrl.replace(/\/+$/, '')}/api/webhooks/whatsapp${tokenQs}`;

    const resultado = await provider.iniciarSessao({ webhookUrl });
    return sucesso(res, resultado);
  } catch (e) {
    return erro(res, `Não foi possível iniciar a sessão no WAHA: ${e.message}`, 502);
  }
});

router.get('/whatsapp/sessao/qr', autenticar, autorizar('gestor'), async (_req, res) => {
  const provider = getProvider();
  if (typeof provider.obterQrCode !== 'function') {
    return erro(res, `O provider atual ("${provider.nome}") não suporta geração de QR Code.`, 400);
  }

  try {
    const qr = await provider.obterQrCode();
    return sucesso(res, qr);
  } catch (e) {
    return erro(res, `QR Code ainda não disponível (verifique se o status é SCAN_QR_CODE): ${e.message}`, 400);
  }
});

router.post('/whatsapp/sessao/logout', autenticar, autorizar('gestor'), async (_req, res) => {
  const provider = getProvider();
  if (typeof provider.desconectarSessao !== 'function') {
    return erro(res, `O provider atual ("${provider.nome}") não suporta logout de sessão.`, 400);
  }

  try {
    const r = await provider.desconectarSessao();
    return sucesso(res, r);
  } catch (e) {
    return erro(res, `Erro ao desconectar sessão: ${e.message}`, 502);
  }
});

module.exports = router;
module.exports.processarEventosWebhook = processarEventosWebhook;
