// src/workers/whatsappWorker.js
// Processa a fila persistente `whatsapp_jobs` (Transactional Outbox) em background.
//
// Garantias:
//  - Claim seguro entre vários workers: SELECT ... FOR UPDATE SKIP LOCKED (MySQL 8+).
//  - Respeita janela de correção (`enviar_apos <= NOW()`) e horário de silêncio (`horarioSilencio`).
//  - Concorrência limitada e intervalo entre envios (para providers não-oficiais como Evolution).
//  - Retry com exponential backoff + jitter, limitado por max_tentativas.
//  - Erros permanentes vão direto para FAILED.
//  - Jobs órfãos em PROCESSING são recuperados após processingTimeoutMs.

const defaultConfig = require('../config/whatsappConfig');
const { getProvider } = require('../providers/whatsapp');
const { TEMPORARIO, PERMANENTE } = require('../providers/whatsapp/comum');
const { normalizarTelefoneBR, mascararTelefone } = require('../utils/telefone');
const { calcularBackoffMs, executarComConcorrencia } = require('./emailWorker');

/**
 * Verifica se `data` (Date local) está dentro do intervalo de silêncio `{ inicioMin, fimMin }`.
 * Suporta janelas que cruzam a meia-noite (ex.: 21:00–07:00 → 1260..420).
 */
function emHorarioSilencio(horarioSilencio, data = new Date()) {
  if (!horarioSilencio) return false;
  const { inicioMin, fimMin } = horarioSilencio;
  if (inicioMin === fimMin) return false;
  const minAtual = data.getHours() * 60 + data.getMinutes();
  if (inicioMin < fimMin) {
    return minAtual >= inicioMin && minAtual < fimMin;
  }
  // Cruza meia-noite (ex.: 21:00 até 07:00)
  return minAtual >= inicioMin || minAtual < fimMin;
}

/** Sanitiza mensagem de erro sem vazar tokens ou quebras de linha. */
function sanitizarErroWa(err, cfg = defaultConfig) {
  let msg = String(err?.message || err || 'Erro desconhecido').replace(/[\r\n]+/g, ' ').trim();
  const segredos = [
    cfg?.meta?.token,
    cfg?.meta?.appSecret,
    cfg?.evolution?.apiKey,
    cfg?.waha?.apiKey,
    cfg?.waha?.hmacSecret,
    cfg?.verifyToken,
  ].filter(s => typeof s === 'string' && s.length >= 4);
  for (const s of segredos) {
    msg = msg.split(s).join('***');
  }
  const prefixo = err?.code && !msg.startsWith('[') ? `[${err.code}] ` : '';
  return (prefixo + msg).slice(0, 500);
}

function createWhatsappWorker({
  db,
  provider = null,
  config = defaultConfig,
  logger = console,
  random = Math.random,
  now = () => new Date(),
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
} = {}) {
  if (!db) throw new Error('createWhatsappWorker: parâmetro "db" é obrigatório');

  const prov = provider || getProvider();
  let timer = null;
  let parando = false;
  let cicloAtual = null;

  const stats = {
    emAndamento: 0,
    picoConcorrencia: 0,
    enviados: 0,
    retries: 0,
    falhas: 0,
    recuperados: 0,
    ciclosEmSilencio: 0,
  };

  /** Devolve à fila jobs presos em PROCESSING além do timeout. */
  async function recuperarOrfaos() {
    const segundos = Math.ceil(config.processingTimeoutMs / 1000);
    const [r] = await db.query(
      `UPDATE whatsapp_jobs
          SET status = IF(tentativas >= max_tentativas, 'FAILED', 'RETRY'),
              ultimo_erro = 'Timeout de processamento (worker interrompido durante o envio)',
              proxima_tentativa_em = NOW()
        WHERE status = 'PROCESSING'
          AND processado_em < DATE_SUB(NOW(), INTERVAL ? SECOND)`,
      [segundos]
    );
    if (r.affectedRows > 0) {
      stats.recuperados += r.affectedRows;
      logger.warn(`[WhatsAppWorker] ${r.affectedRows} job(s) órfão(s) recuperado(s) de PROCESSING.`);
    }
  }

  /**
   * Reivindica até batchSize jobs elegíveis (respeitando `enviar_apos` e `proxima_tentativa_em`).
   */
  async function reivindicarLote() {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [jobs] = await conn.query(
        `SELECT id, usuario_id, aluno_id, destinatario, template, variaveis, mensagem,
                tipo_notificacao, data_referencia, tentativas, max_tentativas
           FROM whatsapp_jobs
          WHERE status IN ('PENDING', 'RETRY')
            AND (enviar_apos IS NULL OR enviar_apos <= NOW())
            AND (proxima_tentativa_em IS NULL OR proxima_tentativa_em <= NOW())
          ORDER BY id
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [config.batchSize]
      );

      if (jobs.length > 0) {
        await conn.query(
          `UPDATE whatsapp_jobs
              SET status = 'PROCESSING', tentativas = tentativas + 1, processado_em = NOW()
            WHERE id IN (?)`,
          [jobs.map(j => j.id)]
        );
      }
      await conn.commit();
      return jobs.map(j => ({ ...j, tentativas: j.tentativas + 1 }));
    } catch (e) {
      try { await conn.rollback(); } catch (_) { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  async function processarJob(job) {
    stats.emAndamento++;
    stats.picoConcorrencia = Math.max(stats.picoConcorrencia, stats.emAndamento);
    try {
      const fone = normalizarTelefoneBR(job.destinatario);
      if (!fone) {
        throw Object.assign(new Error(`Destinatário inválido para E.164 BR: "${mascararTelefone(job.destinatario)}"`), {
          permanente: true,
        });
      }

      const res = await prov.enviar({ ...job, destinatario: fone });
      const providerMsgId = res?.providerMsgId || null;

      await db.query(
        `UPDATE whatsapp_jobs
            SET status = 'SENT',
                provider = ?,
                provider_msg_id = ?,
                status_entrega = COALESCE(status_entrega, 'sent'),
                processado_em = NOW(),
                ultimo_erro = NULL,
                proxima_tentativa_em = NULL
          WHERE id = ? AND tentativas = ? AND status IN ('PROCESSING', 'RETRY')`,
        [prov.nome, providerMsgId, job.id, job.tentativas]
      );
      stats.enviados++;
      logger.log(`[WhatsAppWorker] Job ${job.id} SENT via ${prov.nome} para ${mascararTelefone(fone)} (tentativa ${job.tentativas}).`);

      if (config.intervaloEntreEnviosMs > 0 && !parando) {
        await sleep(config.intervaloEntreEnviosMs);
      }
    } catch (err) {
      await registrarFalha(job, err);
    } finally {
      stats.emAndamento--;
    }
  }

  async function registrarFalha(job, err) {
    const tipo = prov.classificarErro ? prov.classificarErro(err) : TEMPORARIO;
    const msg = sanitizarErroWa(err, config);
    const esgotou = job.tentativas >= job.max_tentativas;

    try {
      if (tipo === PERMANENTE || esgotou) {
        await db.query(
          `UPDATE whatsapp_jobs
              SET status = 'FAILED', status_entrega = 'failed', ultimo_erro = ?, processado_em = NOW(), proxima_tentativa_em = NULL
            WHERE id = ? AND tentativas = ? AND status = 'PROCESSING'`,
          [msg, job.id, job.tentativas]
        );
        stats.falhas++;
        const motivo = tipo === PERMANENTE ? 'erro permanente' : `limite de ${job.max_tentativas} tentativas`;
        logger.error(`[WhatsAppWorker] Job ${job.id} FAILED (${motivo}): ${msg}`);
      } else {
        const atrasoMs = calcularBackoffMs(job.tentativas, {
          baseMs: config.retryBaseDelayMs,
          maxMs: config.retryMaxDelayMs,
          jitterRatio: config.retryJitterRatio,
        }, random);
        await db.query(
          `UPDATE whatsapp_jobs
              SET status = 'RETRY', ultimo_erro = ?,
                  proxima_tentativa_em = DATE_ADD(NOW(), INTERVAL ? SECOND)
            WHERE id = ? AND tentativas = ? AND status = 'PROCESSING'`,
          [msg, Math.ceil(atrasoMs / 1000), job.id, job.tentativas]
        );
        stats.retries++;
        logger.warn(`[WhatsAppWorker] Job ${job.id} RETRY ${job.tentativas}/${job.max_tentativas} em ${Math.ceil(atrasoMs / 1000)}s: ${msg}`);
      }
    } catch (dbErr) {
      logger.error(`[WhatsAppWorker] Falha ao registrar erro do job ${job.id}:`, dbErr.message);
    }
  }

  async function executarCiclo() {
    await recuperarOrfaos();
    if (emHorarioSilencio(config.horarioSilencio, now())) {
      stats.ciclosEmSilencio++;
      return 0;
    }
    const jobs = await reivindicarLote();
    if (jobs.length > 0) {
      logger.log(`[WhatsAppWorker] ${jobs.length} job(s) reivindicado(s) (provider=${prov.nome}, concorrência=${config.concurrency}).`);
      await executarComConcorrencia(jobs, config.concurrency, processarJob);
    }
    return jobs.length;
  }

  async function tick() {
    timer = null;
    if (parando) return;
    let processados = 0;
    cicloAtual = executarCiclo()
      .then(n => { processados = n; })
      .catch(e => logger.error('[WhatsAppWorker] Erro no ciclo:', e.message));
    await cicloAtual;
    cicloAtual = null;
    if (!parando) {
      const espera = processados >= config.batchSize ? 0 : config.pollIntervalMs;
      timer = setTimeout(tick, espera);
    }
  }

  function iniciar() {
    if (timer || cicloAtual) return;
    parando = false;
    logger.log(
      `[WhatsAppWorker] Iniciado (provider=${prov.nome}, concorrência=${config.concurrency}, ` +
      `lote=${config.batchSize}, tentativas=${config.maxTentativas}).`
    );
    timer = setTimeout(tick, 0);
  }

  async function parar() {
    parando = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (cicloAtual) await cicloAtual;
    logger.log('[WhatsAppWorker] Parado.');
  }

  return { iniciar, parar, executarCiclo, stats };
}

let instancia = null;

/**
 * Garante que as colunas e tabelas da Entrega 4 existam no MySQL e normaliza
 * telefones já cadastrados na tabela `pais` (evita falhas caso o SQL manual não tenha sido rodado).
 */
async function garantirSchemaWhatsapp(db) {
  try {
    const [cols] = await db.query("SHOW COLUMNS FROM pais LIKE 'telefone_e164'");
    if (cols.length === 0) {
      await db.query(`
        ALTER TABLE pais
          ADD COLUMN telefone_e164         VARCHAR(16) NULL,
          ADD COLUMN whatsapp_optin        TINYINT(1)  NOT NULL DEFAULT 0,
          ADD COLUMN whatsapp_optin_em     DATETIME    NULL,
          ADD COLUMN whatsapp_optin_origem VARCHAR(30) NULL,
          ADD COLUMN whatsapp_optout_em    DATETIME    NULL,
          ADD KEY idx_pais_telefone_e164 (telefone_e164)
      `);
      console.log('[WhatsAppWorker] Colunas LGPD/WhatsApp adicionadas automaticamente na tabela `pais`.');
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS notificacao_preferencias (
        pai_id INT NOT NULL,
        tipo   VARCHAR(40) NOT NULL,
        canal  ENUM('email','whatsapp') NOT NULL,
        ativo  TINYINT(1) NOT NULL DEFAULT 1,
        atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (pai_id, tipo, canal),
        CONSTRAINT fk_pref_pai FOREIGN KEY (pai_id) REFERENCES pais(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_jobs (
        id INT NOT NULL AUTO_INCREMENT,
        usuario_id INT NOT NULL,
        aluno_id   INT NOT NULL,
        destinatario VARCHAR(16) NOT NULL,
        template  VARCHAR(60) NOT NULL,
        variaveis JSON NOT NULL,
        mensagem  TEXT NOT NULL,
        tipo_notificacao VARCHAR(50) NOT NULL DEFAULT 'falta',
        data_referencia  DATE NOT NULL,
        status ENUM('PENDING','PROCESSING','RETRY','SENT','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
        tentativas     INT NOT NULL DEFAULT 0,
        max_tentativas INT NOT NULL DEFAULT 5,
        ultimo_erro TEXT DEFAULT NULL,
        criado_em     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processado_em DATETIME DEFAULT NULL,
        proxima_tentativa_em DATETIME DEFAULT NULL,
        enviar_apos   DATETIME DEFAULT NULL,
        provider        VARCHAR(20)  DEFAULT NULL,
        provider_msg_id VARCHAR(128) DEFAULT NULL,
        status_entrega ENUM('sent','delivered','read','failed') DEFAULT NULL,
        entregue_em DATETIME DEFAULT NULL,
        lido_em     DATETIME DEFAULT NULL,
        PRIMARY KEY (id),
        KEY idx_wa_jobs_fila (status, enviar_apos, proxima_tentativa_em),
        KEY idx_wa_jobs_usuario (usuario_id),
        KEY idx_wa_jobs_provider_msg (provider_msg_id),
        UNIQUE KEY uq_wa_jobs_idempotencia (aluno_id, tipo_notificacao, data_referencia),
        CONSTRAINT fk_wa_jobs_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
        CONSTRAINT fk_wa_jobs_aluno   FOREIGN KEY (aluno_id)   REFERENCES alunos(id)   ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // Backfill de telefone_e164 para responsáveis que já tinham telefone cadastrado antes da migration.
    // LGPD: NÃO ativa o consentimento automaticamente — o opt-in precisa vir do responsável
    // (Portal da Família) ou da secretaria com registro de origem.
    const [paisSemE164] = await db.query(
      `SELECT id, telefone
         FROM pais
        WHERE telefone IS NOT NULL AND telefone != '' AND telefone_e164 IS NULL`
    );
    for (const p of paisSemE164) {
      const e164 = normalizarTelefoneBR(p.telefone);
      if (e164) {
        await db.query('UPDATE pais SET telefone_e164 = ? WHERE id = ?', [e164, p.id]);
      }
    }

    // Somente em desenvolvimento e sob demanda: destrava jobs de HOJE que ficaram em RETRY/FAILED
    // ou que foram "enviados" pelo provider fake (útil ao trocar fake → waha durante testes).
    // Desligado por padrão: reenviar falhas permanentes a cada restart aumenta o risco de banimento.
    if (process.env.WHATSAPP_DEV_REPROCESSAR_HOJE === 'true'
        && process.env.NODE_ENV !== 'production'
        && defaultConfig.provider && defaultConfig.provider !== 'fake') {
      const [r] = await db.query(
        `UPDATE whatsapp_jobs
            SET status = 'PENDING',
                tentativas = 0,
                proxima_tentativa_em = NULL,
                enviar_apos = NOW(),
                ultimo_erro = NULL,
                provider = NULL,
                provider_msg_id = NULL,
                status_entrega = NULL
          WHERE data_referencia = CURDATE()
            AND (status IN ('RETRY', 'FAILED') OR provider = 'fake')`
      );
      if (r.affectedRows > 0) {
        console.warn(`[WhatsAppWorker] WHATSAPP_DEV_REPROCESSAR_HOJE: ${r.affectedRows} job(s) de hoje recolocado(s) na fila.`);
      }
    }
  } catch (e) {
    console.error('[WhatsAppWorker] Aviso ao verificar schema WhatsApp:', e.message);
  }
}

let schemaPromise = null;
/**
 * Executa garantirSchemaWhatsapp uma única vez por processo.
 * Chamado pelo server mesmo com WHATSAPP_ENABLED=false, para que as rotas de
 * preferências/painel não quebrem quando a migration manual não foi rodada.
 */
function prepararSchemaWhatsapp() {
  if (!schemaPromise) {
    const { dbPromise } = require('../config/database');
    schemaPromise = garantirSchemaWhatsapp(dbPromise);
  }
  return schemaPromise;
}

function iniciarWhatsappWorker() {
  const { dbPromise } = require('../config/database');
  if (!instancia) {
    instancia = createWhatsappWorker({ db: dbPromise });
  }
  prepararSchemaWhatsapp().finally(() => {
    instancia.iniciar();
  });
  return instancia;
}

async function pararWhatsappWorker() {
  if (instancia) await instancia.parar();
}

if (require.main === module) {
  iniciarWhatsappWorker();
  const encerrar = async (sinal) => {
    console.log(`[WhatsAppWorker] ${sinal} recebido, encerrando...`);
    await pararWhatsappWorker();
    process.exit(0);
  };
  process.on('SIGINT', () => encerrar('SIGINT'));
  process.on('SIGTERM', () => encerrar('SIGTERM'));
}

module.exports = {
  createWhatsappWorker,
  emHorarioSilencio,
  sanitizarErroWa,
  iniciarWhatsappWorker,
  pararWhatsappWorker,
  prepararSchemaWhatsapp,
};

