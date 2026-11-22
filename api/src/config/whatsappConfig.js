// src/config/whatsappConfig.js
// Configuração centralizada das notificações via WhatsApp (worker + provider).
// Tudo desligado por padrão: WHATSAPP_ENABLED=true ativa enfileiramento e worker.
if (!process.env.DB_HOST) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
}

function int(nome, padrao, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const bruto = process.env[nome];
  if (bruto === undefined || bruto === '') return padrao;
  const n = Number.parseInt(bruto, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(`[whatsappConfig] ${nome}="${bruto}" inválido (esperado ${min}..${max}). Usando ${padrao}.`);
    return padrao;
  }
  return n;
}

/** "21:00-07:00" → { inicioMin: 1260, fimMin: 420 } (minutos desde 00:00). null = desativado. */
function parseHorarioSilencio(valor) {
  if (!valor || valor === 'off') return null;
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(valor).trim());
  if (!m) {
    console.warn(`[whatsappConfig] WHATSAPP_HORARIO_SILENCIO="${valor}" inválido (formato HH:MM-HH:MM). Desativado.`);
    return null;
  }
  const [, h1, m1, h2, m2] = m.map(Number);
  return { inicioMin: h1 * 60 + m1, fimMin: h2 * 60 + m2 };
}

const provider = (process.env.WHATSAPP_PROVIDER || 'fake').toLowerCase();

// Providers não-oficiais (WAHA/Evolution/Baileys) precisam de ritmo "humano" para
// reduzir risco de banimento: 1 envio por vez e intervalo entre mensagens.
const naoOficial = provider === 'evolution' || provider === 'waha';

const config = {
  enabled: process.env.WHATSAPP_ENABLED === 'true',
  provider,

  // Minutos entre o registro da falta e o envio. Se o professor corrigir a
  // chamada nesse intervalo, o job é cancelado antes de chegar ao responsável.
  janelaCorrecaoMin: int('WHATSAPP_JANELA_CORRECAO_MIN', 15, { min: 0, max: 24 * 60 }),

  // Não envia mensagens nesse intervalo (horário local do servidor).
  horarioSilencio: parseHorarioSilencio(process.env.WHATSAPP_HORARIO_SILENCIO ?? '21:00-07:00'),

  // Link incluído na mensagem (tela do responsável; exige login).
  appPublicUrl: (process.env.APP_PUBLIC_URL || 'http://localhost:5500').replace(/\/+$/, ''),
  nomeEscola: process.env.ESCOLA_NOME || 'GPE',

  // ── Worker ──
  maxTentativas: int('WHATSAPP_MAX_RETRIES', 4, { min: 0, max: 20 }) + 1,
  retryBaseDelayMs: int('WHATSAPP_RETRY_BASE_DELAY_MS', 30_000, { min: 1_000 }),
  retryMaxDelayMs: int('WHATSAPP_RETRY_MAX_DELAY_MS', 30 * 60_000, { min: 1_000 }),
  retryJitterRatio: 0.2,
  concurrency: int('WHATSAPP_WORKER_CONCURRENCY', naoOficial ? 1 : 5, { min: 1, max: 20 }),
  batchSize: int('WHATSAPP_WORKER_BATCH_SIZE', naoOficial ? 5 : 20, { min: 1, max: 200 }),
  pollIntervalMs: int('WHATSAPP_WORKER_POLL_INTERVAL_MS', 10_000, { min: 500 }),
  intervaloEntreEnviosMs: int('WHATSAPP_INTERVALO_ENVIO_MS', naoOficial ? 4_000 : 0, { min: 0 }),
  processingTimeoutMs: int('WHATSAPP_PROCESSING_TIMEOUT_MS', 5 * 60_000, { min: 10_000 }),
  httpTimeoutMs: int('WHATSAPP_HTTP_TIMEOUT_MS', 15_000, { min: 1_000 }),

  // ── Meta Cloud API ──
  meta: {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    token: process.env.WHATSAPP_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION || 'v21.0',
    idioma: process.env.WHATSAPP_TEMPLATE_LANG || 'pt_BR',
  },

  // ── Evolution API ──
  evolution: {
    url: (process.env.EVOLUTION_URL || 'http://localhost:8080').replace(/\/+$/, ''),
    apiKey: process.env.EVOLUTION_API_KEY || '',
    instance: process.env.EVOLUTION_INSTANCE || 'gpe',
  },

  // ── WAHA (WhatsApp HTTP API — waha-core) ──
  waha: {
    url: (process.env.WAHA_URL || 'http://localhost:3001').replace(/\/+$/, ''),
    apiKey: process.env.WAHA_API_KEY || '',
    session: process.env.WAHA_SESSION || 'default',
    hmacSecret: process.env.WAHA_HMAC_SECRET || '',
    checkNumberExists: process.env.WAHA_CHECK_NUMBER_EXISTS !== 'false',
  },

  // Token usado na verificação do webhook (Meta: hub.verify_token; Evolution/WAHA/Fake: ?token=).
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
};

// Pior caso de um lote precisa caber no timeout de PROCESSING.
const piorLoteMs = Math.ceil(config.batchSize / config.concurrency) * (config.httpTimeoutMs + config.intervaloEntreEnviosMs);
if (piorLoteMs >= config.processingTimeoutMs) {
  console.warn(`[whatsappConfig] ATENÇÃO: pior caso do lote (${piorLoteMs}ms) >= WHATSAPP_PROCESSING_TIMEOUT_MS. Reduza o lote.`);
}

config.parseHorarioSilencio = parseHorarioSilencio;
module.exports = config;
