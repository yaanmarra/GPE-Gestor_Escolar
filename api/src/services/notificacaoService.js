// src/services/notificacaoService.js
// Regras de notificação de faltas (in-app + e-mail + WhatsApp).
// Todas as funções recebem a conexão da transação da chamada: a presença e as
// notificações são gravadas juntas (Transactional Outbox) — ou tudo, ou nada.
const emailConfig = require('../config/emailConfig');
const defaultWaConfig = require('../config/whatsappConfig');
const { montarAvisoFalta } = require('./whatsappTemplates');

const SQL_DADOS_RESPONSAVEL = `
  SELECT a.id AS aluno_id, u.id AS usuario_pai_id, u.nome AS nome_responsavel,
         u.email AS email_responsavel, ua.nome AS nome_aluno, t.nome AS turma
    FROM alunos a
    JOIN pais p      ON a.pai_id = p.id
    JOIN usuarios u  ON p.usuario_id = u.id
    JOIN usuarios ua ON a.usuario_id = ua.id
    LEFT JOIN turmas t ON t.id = a.turma_id
   WHERE a.id IN (?)`;

// Só responsáveis com consentimento ativo, telefone válido e preferência não desligada.
const SQL_ELEGIVEIS_WHATSAPP = `
  SELECT a.id AS aluno_id, u.id AS usuario_pai_id, u.nome AS nome_responsavel,
         ua.nome AS nome_aluno, t.nome AS turma, p.telefone_e164
    FROM alunos a
    JOIN pais p      ON a.pai_id = p.id
    JOIN usuarios u  ON p.usuario_id = u.id
    JOIN usuarios ua ON a.usuario_id = ua.id
    LEFT JOIN turmas t ON t.id = a.turma_id
    LEFT JOIN notificacao_preferencias np
           ON np.pai_id = p.id AND np.tipo = 'falta' AND np.canal = 'whatsapp'
   WHERE a.id IN (?)
     AND p.whatsapp_optin = 1
     AND p.whatsapp_optout_em IS NULL
     AND p.telefone_e164 IS NOT NULL
     AND COALESCE(np.ativo, 1) = 1`;

// Reativa um job CANCELLED/FAILED (falta → presente → falta de novo no mesmo dia)
// ou um job que tinha sido "enviado" pelo provider fake.
// Em ON DUPLICATE KEY UPDATE as atribuições são avaliadas da esquerda para a
// direita: `status` é recalculado depois das demais colunas (a condição ainda
// enxerga o status antigo) e `provider` fica por ÚLTIMO (a condição de `status`
// ainda precisa ver provider = 'fake'; todo job fake é reativado, então basta zerá-lo).
const SQL_INSERIR_WHATSAPP = `
  INSERT INTO whatsapp_jobs
    (usuario_id, aluno_id, destinatario, template, variaveis, mensagem,
     tipo_notificacao, data_referencia, status, max_tentativas, enviar_apos)
  VALUES (?, ?, ?, ?, ?, ?, 'falta', ?, 'PENDING', ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))
  ON DUPLICATE KEY UPDATE
    enviar_apos  = IF(status IN ('CANCELLED', 'FAILED') OR provider = 'fake', VALUES(enviar_apos), enviar_apos),
    destinatario = IF(status IN ('CANCELLED', 'FAILED') OR provider = 'fake', VALUES(destinatario), destinatario),
    variaveis    = IF(status IN ('CANCELLED', 'FAILED') OR provider = 'fake', VALUES(variaveis), variaveis),
    mensagem     = IF(status IN ('CANCELLED', 'FAILED') OR provider = 'fake', VALUES(mensagem), mensagem),
    tentativas   = IF(status IN ('CANCELLED', 'FAILED') OR provider = 'fake', 0, tentativas),
    ultimo_erro  = IF(status IN ('CANCELLED', 'FAILED') OR provider = 'fake', NULL, ultimo_erro),
    status_entrega  = IF(status IN ('CANCELLED', 'FAILED') OR provider = 'fake', NULL, status_entrega),
    provider_msg_id = IF(status IN ('CANCELLED', 'FAILED') OR provider = 'fake', NULL, provider_msg_id),
    status       = IF(status IN ('CANCELLED', 'FAILED') OR provider = 'fake', 'PENDING', status),
    provider     = IF(provider = 'fake', NULL, provider)`;

function mensagemFalta({ nome_responsavel, nome_aluno, turma }, data) {
  return `Olá, ${nome_responsavel}. Foi registrada uma FALTA para o aluno ${nome_aluno} (turma ${turma || 'N/A'}) na data ${data}.`;
}

/**
 * Enfileira as notificações de falta para os alunos informados.
 * @returns {Promise<{ notificados: number, whatsapp: number }>}
 */
async function registrarFaltas(conn, { alunoIds, data }, { waConfig = defaultWaConfig } = {}) {
  const ids = [...new Set(alunoIds.map(Number))];
  if (ids.length === 0) return { notificados: 0, whatsapp: 0 };

  // 1. In-app + e-mail (idempotente e com suporte a reativação após retificação)
  const [rows] = await conn.query(SQL_DADOS_RESPONSAVEL, [ids]);
  for (const r of rows) {
    const msg = mensagemFalta(r, data);
    const [notifExistente] = await conn.query(
      'SELECT id FROM notificacoes WHERE usuario_id = ? AND mensagem = ? LIMIT 1',
      [r.usuario_pai_id, msg]
    );
    if (notifExistente.length === 0) {
      await conn.query('INSERT INTO notificacoes (usuario_id, mensagem) VALUES (?, ?)', [r.usuario_pai_id, msg]);
    }
    // Em MySQL ON DUPLICATE KEY UPDATE as atribuições são avaliadas da esquerda para a direita:
    // `status` deve ser atualizado ANTES de `ultimo_erro` ser limpo para NULL.
    await conn.query(
      `INSERT INTO email_jobs (usuario_id, aluno_id, destinatario, assunto, mensagem, tipo_notificacao, data_referencia, status, max_tentativas)
       VALUES (?, ?, ?, ?, ?, 'falta', ?, 'PENDING', ?)
       ON DUPLICATE KEY UPDATE
         destinatario         = IF(status = 'FAILED' AND ultimo_erro = 'Presença corrigida antes do envio', VALUES(destinatario), destinatario),
         assunto              = IF(status = 'FAILED' AND ultimo_erro = 'Presença corrigida antes do envio', VALUES(assunto), assunto),
         mensagem             = IF(status = 'FAILED' AND ultimo_erro = 'Presença corrigida antes do envio', VALUES(mensagem), mensagem),
         tentativas           = IF(status = 'FAILED' AND ultimo_erro = 'Presença corrigida antes do envio', 0, tentativas),
         processado_em        = IF(status = 'FAILED' AND ultimo_erro = 'Presença corrigida antes do envio', NULL, processado_em),
         proxima_tentativa_em = IF(status = 'FAILED' AND ultimo_erro = 'Presença corrigida antes do envio', NULL, proxima_tentativa_em),
         status               = IF(status = 'FAILED' AND ultimo_erro = 'Presença corrigida antes do envio', 'PENDING', status),
         ultimo_erro          = IF(ultimo_erro = 'Presença corrigida antes do envio', NULL, ultimo_erro)`,
      [r.usuario_pai_id, r.aluno_id, r.email_responsavel, `Aviso de falta - ${r.nome_aluno}`, msg, data, emailConfig.maxTentativas]
    );
  }

  // 2. WhatsApp (somente com feature flag + consentimento)
  let whatsapp = 0;
  if (waConfig.enabled) {
    try {
      const [elegiveis] = await conn.query(SQL_ELEGIVEIS_WHATSAPP, [ids]);
      for (const r of elegiveis) {
        const { template, variaveis, mensagem } = montarAvisoFalta(
          { nomeResponsavel: r.nome_responsavel, nomeAluno: r.nome_aluno, turma: r.turma, data },
          waConfig
        );
        await conn.query(SQL_INSERIR_WHATSAPP, [
          r.usuario_pai_id, r.aluno_id, r.telefone_e164, template, JSON.stringify(variaveis), mensagem,
          data, waConfig.maxTentativas, waConfig.janelaCorrecaoMin,
        ]);
        whatsapp++;
      }
    } catch (err) {
      if (err?.code !== 'ER_NO_SUCH_TABLE' && err?.code !== 'ER_BAD_FIELD_ERROR') {
        throw err;
      }
    }
  }

  return { notificados: rows.length, whatsapp };
}

/**
 * Cancela avisos pendentes (e-mail e WhatsApp) ainda não enviados quando a falta foi corrigida
 * (ex.: professor trocou "falta" por "presente" ou "justificado" antes do envio).
 * Jobs já enviados (status = 'SENT') são preservados integralmente.
 * @returns {Promise<number>} quantidade de alunos com jobs pendentes cancelados
 */
async function cancelarFaltasCorrigidas(conn, { alunoIds, data }, { waConfig = defaultWaConfig } = {}) {
  const candidatos = [...new Set(alunoIds.map(Number))];
  if (!candidatos.length) return 0;
  const [faltas] = await conn.query(
    "SELECT DISTINCT aluno_id FROM presencas WHERE aluno_id IN (?) AND data = ? AND status = 'falta'",
    [candidatos, data]
  );
  const comFalta = new Set(faltas.map(r => Number(r.aluno_id)));
  const ids = candidatos.filter(id => !comFalta.has(id));
  if (!ids.length) return 0;

  const [rEmail] = await conn.query(
    `UPDATE email_jobs
        SET status = 'FAILED',
            ultimo_erro = 'Presença corrigida antes do envio',
            processado_em = NOW(),
            proxima_tentativa_em = NULL
      WHERE aluno_id IN (?) AND data_referencia = ? AND tipo_notificacao = 'falta'
        AND status IN ('PENDING', 'RETRY')`,
    [ids, data]
  );
  const emailCancelados = rEmail.affectedRows || 0;

  let waCancelados = 0;
  try {
    const [rWa] = await conn.query(
      `UPDATE whatsapp_jobs
          SET status = 'CANCELLED',
              ultimo_erro = 'Presença corrigida antes do envio',
              processado_em = NOW(),
              proxima_tentativa_em = NULL
        WHERE aluno_id IN (?) AND data_referencia = ? AND tipo_notificacao = 'falta'
          AND status IN ('PENDING', 'RETRY')`,
      [ids, data]
    );
    waCancelados = rWa.affectedRows || 0;
  } catch (err) {
    if (waConfig.enabled || err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }

  return waConfig.enabled ? (waCancelados || emailCancelados) : Math.max(emailCancelados, waCancelados);
}

module.exports = { registrarFaltas, cancelarFaltasCorrigidas, mensagemFalta };
