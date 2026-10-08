// src/config/emailConfig.js
// Configuração centralizada do envio de e-mails (worker + SMTP).
// Todos os valores podem ser sobrescritos via .env. Os defaults estão justificados abaixo.
if (!process.env.DB_HOST) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
}

function int(nome, padrao, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const bruto = process.env[nome];
  if (bruto === undefined || bruto === '') return padrao;
  const n = Number.parseInt(bruto, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(`[emailConfig] ${nome}="${bruto}" inválido (esperado ${min}..${max}). Usando ${padrao}.`);
    return padrao;
  }
  return n;
}

function float(nome, padrao, { min = 0, max = 1 } = {}) {
  const bruto = process.env[nome];
  if (bruto === undefined || bruto === '') return padrao;
  const n = Number.parseFloat(bruto);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(`[emailConfig] ${nome}="${bruto}" inválido (esperado ${min}..${max}). Usando ${padrao}.`);
    return padrao;
  }
  return n;
}

const config = {
  // ── RETRY ──────────────────────────────────────────────
  // Nº de RE-tentativas após a 1ª tentativa. 4 retries = 5 tentativas no total,
  // o mesmo valor do DEFAULT da coluna email_jobs.max_tentativas.
  maxRetries: int('EMAIL_MAX_RETRIES', 4, { min: 0, max: 20 }),

  // Backoff exponencial: base * 2^(tentativa-1) → 30s, 1min, 2min, 4min.
  // Janela total de ~7,5 min: cobre quedas curtas de rede e throttling temporário
  // do SMTP (respostas 421/45x) sem segurar e-mails de falta por horas.
  retryBaseDelayMs: int('EMAIL_RETRY_BASE_DELAY_MS', 30_000, { min: 1_000 }),

  // Teto do atraso, para o caso de alguém aumentar EMAIL_MAX_RETRIES.
  retryMaxDelayMs: int('EMAIL_RETRY_MAX_DELAY_MS', 15 * 60_000, { min: 1_000 }),

  // Jitter (0..1): reduz o atraso aleatoriamente em até X%. Evita que vários jobs que
  // falharam juntos (ex.: SMTP caiu) voltem todos no mesmo segundo ("thundering herd").
  retryJitterRatio: float('EMAIL_RETRY_JITTER_RATIO', 0.2),

  // ── WORKER ─────────────────────────────────────────────
  // Igual a smtp.maxConnections: cada "lane" de envio usa uma conexão do pool.
  // Concorrência maior que o nº de conexões só enfileiraria dentro do Nodemailer.
  concurrency: int('EMAIL_WORKER_CONCURRENCY', 5, { min: 1, max: 50 }),

  // Jobs reivindicados por ciclo. 4× a concorrência: lote pequeno o bastante para
  // terminar bem antes de processingTimeoutMs (ver validação abaixo).
  batchSize: int('EMAIL_WORKER_BATCH_SIZE', 20, { min: 1, max: 500 }),

  // Intervalo entre ciclos quando a fila está vazia/parcial. Se o lote veio cheio,
  // o próximo ciclo roda imediatamente.
  pollIntervalMs: int('EMAIL_WORKER_POLL_INTERVAL_MS', 5_000, { min: 200 }),

  // Job em PROCESSING há mais que isso é considerado órfão (processo morreu no meio)
  // e volta a ser elegível. Precisa ser MUITO maior que o pior caso de um envio
  // (connection + greeting + socket timeout), senão um envio lento seria duplicado.
  processingTimeoutMs: int('EMAIL_PROCESSING_TIMEOUT_MS', 5 * 60_000, { min: 10_000 }),

  // ── SMTP (Nodemailer) ──────────────────────────────────
  smtp: {
    // pool: reaproveita conexões TLS autenticadas em vez de abrir 1 por e-mail.
    pool: process.env.SMTP_POOL !== 'false',
    // Default do próprio Nodemailer. Mantido baixo de propósito: o Gmail limita
    // conexões simultâneas por conta e responde 421 quando excedido.
    maxConnections: int('SMTP_MAX_CONNECTIONS', 5, { min: 1, max: 20 }),
    // Default do Nodemailer: recicla a conexão a cada 100 mensagens, evitando que
    // o servidor derrube conexões muito longas no meio de um envio.
    maxMessages: int('SMTP_MAX_MESSAGES', 100, { min: 1 }),
    // Defaults do Nodemailer são 2min / 30s / 10min — longos demais: um SMTP
    // pendurado travaria uma lane do worker por até 10 minutos.
    connectionTimeout: int('SMTP_CONNECTION_TIMEOUT_MS', 10_000, { min: 1_000 }),
    greetingTimeout:   int('SMTP_GREETING_TIMEOUT_MS', 10_000, { min: 1_000 }),
    socketTimeout:     int('SMTP_SOCKET_TIMEOUT_MS', 30_000, { min: 1_000 }),
  },
};

config.maxTentativas = config.maxRetries + 1;

// Validação de coerência: o pior caso de um lote inteiro precisa caber no timeout
// de PROCESSING, senão jobs ainda em envio seriam reivindicados por outro worker.
const piorEnvioMs = config.smtp.connectionTimeout + config.smtp.greetingTimeout + config.smtp.socketTimeout;
const piorLoteMs = Math.ceil(config.batchSize / config.concurrency) * piorEnvioMs;
if (piorLoteMs >= config.processingTimeoutMs) {
  console.warn(
    `[emailConfig] ATENÇÃO: pior caso do lote (${piorLoteMs}ms) >= EMAIL_PROCESSING_TIMEOUT_MS ` +
    `(${config.processingTimeoutMs}ms). Reduza EMAIL_WORKER_BATCH_SIZE ou aumente o timeout ` +
    'para evitar envios duplicados.'
  );
}

module.exports = config;
