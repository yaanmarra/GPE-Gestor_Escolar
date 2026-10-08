// src/workers/emailWorker.js
// Processa a fila persistente `email_jobs` (Transactional Outbox) em background.
//
// Garantias:
//  - Claim seguro entre vários workers: SELECT ... FOR UPDATE SKIP LOCKED (MySQL 8+).
//  - Concorrência limitada (EMAIL_WORKER_CONCURRENCY), sem Promise.all ilimitado.
//  - Retry com exponential backoff + jitter, limitado por max_tentativas.
//  - Erros permanentes vão direto para FAILED.
//  - Jobs órfãos em PROCESSING (processo morreu no meio) são recuperados.
//
// Uso:
//  - Embutido no servidor: server.js chama iniciarWorker() (EMAIL_WORKER_INLINE != 'false').
//  - Processo separado:    npm run worker

const defaultConfig = require('../config/emailConfig');
const emailService = require('../services/emailService');

// ─────────────────────────────────────────
// Funções puras (testáveis isoladamente)
// ─────────────────────────────────────────

/**
 * Atraso antes da próxima tentativa.
 * tentativa = nº da tentativa que acabou de falhar (1, 2, 3...).
 * base * 2^(tentativa-1), limitado a maxDelay, menos até `jitterRatio` aleatório.
 */
function calcularBackoffMs(tentativa, { baseMs, maxMs, jitterRatio = 0 }, random = Math.random) {
  const exp = Math.min(baseMs * 2 ** Math.max(0, tentativa - 1), maxMs);
  const jitter = jitterRatio > 0 ? exp * jitterRatio * random() : 0;
  return Math.max(1_000, Math.round(exp - jitter));
}

/**
 * Executa `fn` sobre `itens` com no máximo `limite` execuções simultâneas.
 * Cria `limite` "lanes" que consomem uma fila compartilhada — nunca há mais
 * que `limite` promessas pendentes. Erros de um item não interrompem os demais.
 */
async function executarComConcorrencia(itens, limite, fn) {
  let proximo = 0;
  const lanes = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (proximo < itens.length) {
      const item = itens[proximo++];
      try { await fn(item); } catch (_) { /* tratado dentro de fn */ }
    }
  });
  await Promise.all(lanes); // no máximo `limite` lanes
}

// ─────────────────────────────────────────
// Worker
// ─────────────────────────────────────────

function createEmailWorker({
  db,                                         // pool mysql2/promise
  enviar = emailService.enviarEmailNotificacao,
  classificarErro = emailService.classificarErro,
  sanitizarErro = emailService.sanitizarErro,
  emailValido = emailService.emailValido,
  config = defaultConfig,
  logger = console,
  random = Math.random,
} = {}) {
  if (!db) throw new Error('createEmailWorker: parâmetro "db" é obrigatório');

  let timer = null;
  let parando = false;
  let cicloAtual = null;

  // Métricas simples (também usadas nos testes de concorrência)
  const stats = { emAndamento: 0, picoConcorrencia: 0, enviados: 0, retries: 0, falhas: 0, recuperados: 0 };

  /** Devolve à fila jobs presos em PROCESSING além do timeout. */
  async function recuperarOrfaos() {
    const segundos = Math.ceil(config.processingTimeoutMs / 1000);
    const [r] = await db.query(
      `UPDATE email_jobs
          SET status = IF(tentativas >= max_tentativas, 'FAILED', 'RETRY'),
              ultimo_erro = 'Timeout de processamento (worker interrompido durante o envio)',
              proxima_tentativa_em = NOW()
        WHERE status = 'PROCESSING'
          AND processado_em < DATE_SUB(NOW(), INTERVAL ? SECOND)`,
      [segundos]
    );
    if (r.affectedRows > 0) {
      stats.recuperados += r.affectedRows;
      logger.warn(`[EmailWorker] ${r.affectedRows} job(s) órfão(s) recuperado(s) de PROCESSING.`);
    }
  }

  /**
   * Reivindica até batchSize jobs elegíveis numa transação curta.
   * SKIP LOCKED faz outros workers pularem as linhas já travadas por este,
   * em vez de esperar ou pegar o mesmo job. A tentativa é contada no claim:
   * se o processo morrer durante o envio, a tentativa não "some".
   */
  async function reivindicarLote() {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [jobs] = await conn.query(
        `SELECT id, destinatario, assunto, mensagem, tentativas, max_tentativas
           FROM email_jobs
          WHERE status IN ('PENDING', 'RETRY')
            AND (proxima_tentativa_em IS NULL OR proxima_tentativa_em <= NOW())
          ORDER BY id
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [config.batchSize]
      );

      if (jobs.length > 0) {
        await conn.query(
          `UPDATE email_jobs
              SET status = 'PROCESSING', tentativas = tentativas + 1, processado_em = NOW()
            WHERE id IN (?)`,
          [jobs.map(j => j.id)]
        );
      }
      await conn.commit();
      return jobs.map(j => ({ ...j, tentativas: j.tentativas + 1 }));
    } catch (e) {
      try { await conn.rollback(); } catch (_) { /* conexão pode estar quebrada */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  /**
   * Processa um job já reivindicado. As atualizações usam `tentativas = ?` como
   * token: se o job foi recuperado como órfão e reivindicado por outro worker,
   * este UPDATE afeta 0 linhas e não sobrescreve o estado mais novo.
   */
  async function processarJob(job) {
    stats.emAndamento++;
    stats.picoConcorrencia = Math.max(stats.picoConcorrencia, stats.emAndamento);
    try {
      if (!emailValido(job.destinatario)) {
        const e = new Error(`Destinatário inválido: "${job.destinatario}"`);
        e.permanente = true;
        throw e;
      }

      await enviar(job.destinatario, job.assunto, job.mensagem);

      await db.query(
        `UPDATE email_jobs
            SET status = 'SENT', processado_em = NOW(), ultimo_erro = NULL, proxima_tentativa_em = NULL
          WHERE id = ? AND tentativas = ? AND status IN ('PROCESSING', 'RETRY')`,
        [job.id, job.tentativas]
      );
      stats.enviados++;
      logger.log(`[EmailWorker] Job ${job.id} SENT (tentativa ${job.tentativas}).`);
    } catch (err) {
      await registrarFalha(job, err);
    } finally {
      stats.emAndamento--;
    }
  }

  async function registrarFalha(job, err) {
    const tipo = classificarErro(err);
    const msg = sanitizarErro(err);
    const esgotou = job.tentativas >= job.max_tentativas;

    try {
      if (tipo === emailService.PERMANENTE || esgotou) {
        await db.query(
          `UPDATE email_jobs
              SET status = 'FAILED', ultimo_erro = ?, processado_em = NOW(), proxima_tentativa_em = NULL
            WHERE id = ? AND tentativas = ? AND status = 'PROCESSING'`,
          [msg, job.id, job.tentativas]
        );
        stats.falhas++;
        const motivo = tipo === emailService.PERMANENTE ? 'erro permanente' : `limite de ${job.max_tentativas} tentativas`;
        logger.error(`[EmailWorker] Job ${job.id} FAILED (${motivo}): ${msg}`);
      } else {
        const atrasoMs = calcularBackoffMs(job.tentativas, {
          baseMs: config.retryBaseDelayMs,
          maxMs: config.retryMaxDelayMs,
          jitterRatio: config.retryJitterRatio,
        }, random);
        await db.query(
          `UPDATE email_jobs
              SET status = 'RETRY', ultimo_erro = ?,
                  proxima_tentativa_em = DATE_ADD(NOW(), INTERVAL ? SECOND)
            WHERE id = ? AND tentativas = ? AND status = 'PROCESSING'`,
          [msg, Math.ceil(atrasoMs / 1000), job.id, job.tentativas]
        );
        stats.retries++;
        logger.warn(`[EmailWorker] Job ${job.id} RETRY ${job.tentativas}/${job.max_tentativas} em ${Math.ceil(atrasoMs / 1000)}s: ${msg}`);
      }
    } catch (dbErr) {
      // Se nem o UPDATE funcionar, o job fica em PROCESSING e será recuperado
      // por recuperarOrfaos() após o timeout. Nada se perde.
      logger.error(`[EmailWorker] Falha ao registrar erro do job ${job.id}:`, dbErr.message);
    }
  }

  /** Um ciclo completo: recupera órfãos, reivindica lote, processa com concorrência limitada. */
  async function executarCiclo() {
    await recuperarOrfaos();
    const jobs = await reivindicarLote();
    if (jobs.length > 0) {
      logger.log(`[EmailWorker] ${jobs.length} job(s) reivindicado(s) (concorrência ${config.concurrency}).`);
      await executarComConcorrencia(jobs, config.concurrency, processarJob);
    }
    return jobs.length;
  }

  // setTimeout encadeado (e não setInterval): um ciclo nunca começa antes do
  // anterior terminar, mesmo que o SMTP esteja lento.
  async function tick() {
    timer = null;
    if (parando) return;
    let processados = 0;
    cicloAtual = executarCiclo()
      .then(n => { processados = n; })
      .catch(e => logger.error('[EmailWorker] Erro no ciclo:', e.message));
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
      `[EmailWorker] Iniciado (concorrência=${config.concurrency}, lote=${config.batchSize}, ` +
      `tentativas=${config.maxTentativas}, backoff base=${config.retryBaseDelayMs}ms).`
    );
    timer = setTimeout(tick, 0);
  }

  /** Para de buscar novos jobs e aguarda o ciclo atual terminar. */
  async function parar() {
    parando = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (cicloAtual) await cicloAtual;
    logger.log('[EmailWorker] Parado.');
  }

  return { iniciar, parar, executarCiclo, stats };
}

// ─────────────────────────────────────────
// Instância padrão (usada pelo server.js e pelo CLI)
// ─────────────────────────────────────────
let instancia = null;

function iniciarWorker() {
  if (!instancia) {
    const { dbPromise } = require('../config/database');
    instancia = createEmailWorker({ db: dbPromise });
  }
  instancia.iniciar();
  return instancia;
}

async function pararWorker() {
  if (instancia) await instancia.parar();
  emailService.fecharTransporter();
}

if (require.main === module) {
  iniciarWorker();
  const encerrar = async (sinal) => {
    console.log(`[EmailWorker] ${sinal} recebido, encerrando...`);
    await pararWorker();
    process.exit(0);
  };
  process.on('SIGINT', () => encerrar('SIGINT'));
  process.on('SIGTERM', () => encerrar('SIGTERM'));
}

module.exports = {
  createEmailWorker,
  calcularBackoffMs,
  executarComConcorrencia,
  iniciarWorker,
  pararWorker,
};
